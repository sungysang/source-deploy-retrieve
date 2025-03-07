# Source-Deploy-Retrieve (SDR) Handbook

## Table of Contents

- [Introduction](#introduction)
- [Symbol Key](#symbol-key)
- [Metadata Registry](#metadata-registry)
  - [The registry.json file](#the-registryjson-file)
  - [Updating the registry.json file](#updating-the-registryjson-file)
  - [The registry object](#the-registry-object)
  - [Querying registry data](#querying-registry-data)
- [Component Resolution](#component-resolution)
  - [Resolving from metadata files](#resolving-from-metadata-files)
  - [Resolving from a manifest file (package.xml)](#resolving-from-a-manifest-file-packagexml)
  - [Tree containers](#tree-containers)
    - [Creating mock components with the VirtualTreeContainer](#creating-mock-components-with-the-virtualtreecontainer)
- [Component Packaging](#component-packaging)
  - [Converting metadata](#converting-metadata)
  - [The conversion pipeline](#the-conversion-pipeline)
    - [ComponentReader](#componentreader)
    - [ComponentConverter](#componentconverter)
    - [ComponentWriter](#componentwriter)
    - [ConvertContext](#convertcontext)
    - [Example code](#in-decomposedmetadatatransformerts)
- [Component Merging](#component-merging)
  - [CustomObjects across multiple package directories](#customobjects-across-multiple-package-directories)
- [Component Sets](#component-sets)
  - [Creating a set](#creating-a-set)
  - [Initializing a set from metadata files](#initializing-a-set-from-metadata-files)
  - [Initializing a set from a manifest file](#initializing-a-set-from-a-manifest-file)
  - [Lazy pipeline methods](#lazy-pipeline-methods)
- [Deploying and Retrieving](#deploying-and-retrieving)
  - [Establishing an org connection](#establishing-an-org-connection)
  - [Deploying](#deploying)
    - [Example code](#deploy-with-a-source-path)
  - [Retrieving](#retrieving)
    - [Example code](#retrieve-with-a-source-path)
- [Further Examples](#further-examples)

## Introduction

The SDR library is a JavaScript toolkit for working with Salesforce metadata. It is the succeeding architecture of the source-driven development code in the force-com-toolbelt. The rewrite was designed with the following in mind: speed, memory efficiency, and modularity/“[hackability](https://testing.googleblog.com/2016/08/hackable-projects.html)“. We embrace these traits by using [NodeJS streams](https://nodejs.org/api/stream.html), the latest developments in the NodeJS and Typescript ecosystem, and designing extendable interfaces.

Guiding Principles:

- Loosely coupled design - No assumptions are made about the consumers of the modules
- Solutions aren’t built for specific metadata types, but for classifications of types
  - _“But wait, aren’t there implementations and behaviors coded for specific types?”_ Yes there technically are - which makes this statement a bit hypocritical. However, it’s more about having the mindset of developing against a classification rather than specific metadata types. It boils down to being able to unit test in isolation from the real data as well as leaving room for future types that might fall under the same classification as existing ones.
- Configuration driven to easily add new metadata types and change behavior of existing ones
- Consider speed and memory usage with every change made

SDR was built to accomplish the task of deploying and retrieving metadata. There are a few steps that take place during the entire deploy or retrieve process though, and the library makes a point to distinctly treat them as separate modules. You can generally think of each of these modules as a “stage” in a metadata operation’s pipeline. While the modules might have some dependencies with one another, they can also be used somewhat in isolation to perform more granular operations. This unlocks the potential to build more flexible metadata tooling, as well as support existing granular commands that the CLI already has - we did not want to build this for just a VS Code experience.

## Symbol Key

💡 **Idea** - Improvements and interesting concepts that could be worth exploring more

🛠 **Maintenance** - Work that should be done sooner rather than later

📝 **Note** - An interesting tidbit of information that should be kept in mind

🧽 **Refactor/Clean** - Nice to tidy up. Not crucial, they’re just nit picky things that the author, Bryan, dislikes. If someone feels similarly about cleaning up then go forth and conquer

## Metadata Registry

**Module:** <https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/registry>

### Overview

The metadata registry is the foundation of the library. It is a module to describe available metadata types on the platform, provide metadata about them (metadata of metadata woah), and other configuration. It is based off of the [describeMetadata()](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_describe.htm) API call, which provides information such as a type’s file suffix, directory name of its component files, whether or not components live in a folder type, etc. Additional information may also be added to a type definition to support functionality in the library. Not only is it an index of metadata types, but it also contains indexes on properties of metadata types to increase performance on certain operations — more on this later.

### The [registry.json](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/registry/registry.json) file

The config file consists of a handful of different indexes.

`types` contains an entry for each supported metadata type. As already mentioned, these entries contain metadata the library relies on to perform a variety of operations that will be described later.

`suffixes` maps file suffixes to metadata type ids. When parsing a file path, we can examine the file suffix and use this index to map what type it belongs to, providing a performance optimization. Not every metadata type has an associated file suffix, for those we use the following index instead.

`strictDirectoryNames` maps type directory names to the matching metadata type id. Types listed here are **required** to have their files located in a path that has a folder ancestor with the assigned directory name. We cannot determine some types from a file path’s file suffix alone for a handful of reasons:

- A type doesn’t have an assigned file suffix. This is common for bundle types (LightningComponentBundle, WaveTemplateBundle, etc)
- Two exposed metadata types share a file suffix. This is an undesirable pattern in the library, and the only way to reconcile it is to force one of the types to require a strict parent. Break the tie by forcing the newest type to require a strict parent. CustomSite is an example of this.
- A type is exposed with a suffix by the name of `xml` - a reserved suffix. I’m looking at you EmailServicesFunction.

`childTypes` maps child component file suffixes to their parent’s type id. This helps when, for instance, we are parsing a decomposed component file such as a CustomField on a CustomObject. We are then able to quickly identify the parent type of the file. This is primarily beneficial for decomposed components but may have other uses in the future.

`apiVersion` is meant to reflect the api version the registry configuration is aligned with. It’s also used as the default api version for a handful of operations like generating package XMLs or deploying/retrieving.

### Updating the registry.json file

This file is large and luckily, not entirely crafted by hand. And because new metadata types are being added to the platform each release, we’ll need to update the registry.json file. The update-registry module in the scripts folder automatically updates the registry as best it can using a describeMetadata() call against a provided Salesforce org, without overwriting manual changes. It also attempts to update the indexes listed in the previous section. When generating a new version of the registry, it’s important to manually review the changes to ensure they make sense and aren’t destructive. When in doubt, test functionality with the new version. See [Contributing Metadata Types to the Registry](./contributing/metadata.md) in the development README on how to invoke the script with Yarn.

Unfortunately. we sometimes need to manually change a type definition, albeit rarely. The `typeOverride.json` file allows us to overwrite any updates the script attempts to make that we don’t want to happen.

🛠 _At the moment, updating the registry is a manual process when it should be something that runs after a major release automatically. We are investigating how to best make this happen as of 7/01/2021._

🛠 _Another issue is we are limited by the permissions and licenses of the org that we are running the update script on, which may return incomplete describe information. We need to address this as soon as possible to not run into type gaps between releases. This is being worked on as of 7/16/2021._

### The registry object

The library exports at the public API level a JavaScript object version of the registry.json file. This object is also used internally to reference registry data. If a consumer finds themselves needing references to metadata types or describe information, they can use this object:

```
import { registry } from '@salesforce/source-deploy-retrieve'

registry.types.apexclass.name === 'ApexClass' // => true
registry.types.auradefinitionbundle.directoryName // => 'aura'
```

📝 _The registry object is “deeply frozen”, meaning none of its properties, even the nested ones, are mutable. This is to ensure that a consumer cannot change registry information in a process and potentially affect functionality._

### Querying registry data

While it’s perfectly fine to reference the registry export directly, the `RegistryAccess` class was created to make accessing the object a bit more streamlined. Querying types and searching the registry is oftentimes easier and cleaner this way and contains built-in checking for whether or not a metadata type exists. Here’s a comparison of using each:

```
import { RegistryAccess, registry } from '@salesforce/source-deploy-retrieve'

// we can optionally pass custom registry data to the constructor
const registryAccess = new RegistryAccess();


// query type by suffix
registryAccess.getTypeBySuffix('cls')
registry.types[registry.suffixes['cls']]

// child types
registryAccess.getTypeByName('CustomField');
registry.types[registry.childTypes['customfield']].children['customfield']

// get strict directory types
registryAccess.getStrictFolderTypes();
Object.values(registry.strictDirectoryNames).map(
    (typeId) => registry.types[typeId]
);
```

📝 _If you find yourself writing some logic that involves querying the registry, consider adding a new method to_ `RegistryAccess`_. Even if it maybe won’t be used in another place again, it’s often easier to read and nice to keep query logic in the same place._

## Component Resolution

**Module:** <https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/resolve>

### Overview

Almost every operation consists of working with metadata components. SDR abstracts Salesforce metadata with the `MetadataComponent` Typescript interface. These are objects consisting of a `fullName` and `type` property, where `type` is an object pulled from the type index of the registry object. This allows us to easily access registry data of a type right from a component object. Constructing objects that adhere to the component interface is known as **component resolution**. It could be as simple as building the object yourself, or it could be through some other helper mechanism. The latter is more likely and these mechanisms are referred to as **resolvers.**

### Resolving from metadata files

Constructing component objects from files is a core feature of the library. This is the basis of the source deploy and source retrieve commands of the VSCode extensions and the CLI. The `MetadataResolver` class walks files from a given file path and constructs `SourceComponent` instances. This class implements the `MetadataComponent` interface and contains additional properties and methods to work with the collection of files that belong to a component. These are also referred to as **source-backed components**, since the components have files associated with them.

```
import { MetadataResolver } from '@salesforce/source-deploy-retrieve'

const resolver = new MetadataResolver();
const components = resolver.getComponentsFromPath('/path/to/force-app');

// or a single component
const [apexClass] = resolver.getComponentsFromPath('/classes/MyClass.cls');
apexClass.fullName // => 'MyClass'
apexClass.xml // => '/classes/MyClass.cls-meta.xml'
```

Metadata types often follow a pattern of how files are structured for one of its components. For example, a component of an Apex class or Apex trigger follows this structure:

- [class name].[file suffix]
- [class name].[file suffix]-meta.xml

The resolver constructs components based on the rules of such a pattern. It takes advantage of the fact there aren’t very many unique patterns/classifications, and for each one there is a `SourceAdapter` implementation that is responsible for populating the properties of a component based on the rules. Types are assigned adapters with the `strategies` property of the type definition in registry configuration. See the [adapters module](https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/resolve/adapters) for all of the available adapters for different type classifications. The resolver’s algorithm when walking a file is:

1. Determine the associated type by parsing the file suffix. Utilize the registry indexes to determine a type
2. If the type has a source adapter assigned to it, construct the associated adapter. Otherwise use the default one
3. Call the adapter’s `getComponent()` method to construct the source component

📝 _CAREFULLY_ _consider whether new adapters need to be added. Ideally, we should never have to add another one and new types should follow existing conventions to reduce maintenance burden._

🛠 _Most types will not need an adapter assigned to them. Unfortunately, for those that do, it is a manual process at the moment to update the registry with the right configuration value. There is an ongoing effort to help automatically set the configuration as needed, but for now we will have to do this._

🧽 _The name_ `MetadataResolver` _is a relic from when it was the only resolver. A more apt name would be_ `SourceResolver`. _For the sake of the guide and to avoid ambiguity, I’m going to call it the source resolver. If this ends up being confusing then change it._

### Resolving from a manifest file (package.xml)

The `ManifestResolver` class parses a [manifest file](https://trailhead.salesforce.com/en/content/learn/modules/package-xml/package-xml-adventure) to construct components. **Unlike resolving from files, this resolver does not construct source-backed components** because a manifest tells us nothing about where files live. If you think about it, some operations don’t require local files at all, such as when retrieving components to a blank new project.

```
import { ManifestResolver } from '@salesforce/source-deploy-retrieve';

(async () => {
   const resolver = new ManifestResolver();
   const components = await resolver.resolve('/path/to/package.xml');
   components.forEach(c => console.log(`${c.fullName} - ${c.type.name}`))
})()
```

📝 _So if the manifest resolver doesn’t create source-backed components, how do the deploy/retrieve commands work that utilize a manifest? We’ll go over this in the section Initializing a set from a manifest file. Those objects have an initializer that combines the efforts of the source and manifest resolvers to do exactly that. Following the principles of the library, we make pieces of functionality as building block modules to support larger operations. A tool author may just want to build something that analyzes and manipulates manifest files, so we don’t tightly couple it with assumptions about deploying and retrieving._

### Tree containers

A `TreeContainer` is an encapsulation of a file system that enables I/O against anything that can be abstracted as one. The implication is a client can resolve source-backed components against alternate file system abstractions. By default for most operations, the `NodeFSTreeContainer` is used, which is simply a wrapper of the Node file system api calls. There is also the `ZipTreeContainer`, which is used for scanning components against the central directory of a zip file, and the `VirtualTreeContainer`, helpful for creating mock components in testing scenarios. This concept is central to how we resolve and extract components in a retrieved zip file.

Clients can implement new tree containers by extending the `TreeContainer` base class and expanding functionality. Not all methods of a tree container have to be implemented, but an error will be thrown if the container is being used in a context that requires particular methods.

💡*The author, Brian, demonstrated the extensibility of tree containers for a side project by creating a* `GitTreeContainer`_. This enabled resolving components against a git object tree, allowing us to perform component diffs between git refs and analyze GitHub projects. See the [SFDX Badge Generator](https://sfdx-badge.herokuapp.com/). This could be expanded into a plugin of some sort._

#### Creating mock components with the VirtualTreeContainer

If a consumer needs to create fake components for testing, the `VirtualTreeContainer` is a great way to do so without having to create real local files in a project. This is how the library tests its own functionality in fact.

```
import {
   ComponentSet,
   registry,
   VirtualDirectory,
   VirtualTreeContainer
} from '@salesforce/source-deploy-retrieve'

// resolve components of a virtual tree
const virtualTree = new VirtualTreeContainer([
  {
    dirPath: '.',
    children: ['MyClass.cls', 'MyClass.cls-meta.xml', 'folder2']
  },
  {
    dirPath: '/folder2',
    children: ['MyClass2.cls', 'MyClass2.cls-meta.xml']
  }
]);
const components = ComponentSet.fromSource({
  fsPaths: ['.'],
  tree: virtualTree
});
components.toArray() // => [<MyClass>, <MyClass2>]


// create an individual component
const virtualFs: VirtualDirectory[] = [
  {
    dirPath: '/metadata',
    children: [
      {
        name: 'MyLayout.layout',
        data: Buffer.from('<Layout></Layout>')
      }
    ]
  }
]
const layout = SourceComponent.createVirtualComponent({
  name: 'MyLayout',
  type: registry.types.layout,
  xml: '/metadata/MyLayout.layout'
}, virtualFs);

console.log(await layout.parseXml()) // => "<Layout></Layout>"
```

## Component Packaging

**Module:** <https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/convert>

### Overview

Another key building block for deploying and retrieving is copying metadata files to or from a zip file. The component packaging functionality is responsible for this aspect. It also handles the SFDX concept of converting files between source and metadata format (see [Salesforce DX Project Structure and Source Format](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_source_file_format.htm#:~:text=It's%20called%20source%20format.,say%20goodbye%20to%20messy%20merges.)) Not only is it used during deploys and retrieves, but also in isolation for various other use cases — think of the CLI convert commands.

### Converting metadata

We can resolve, convert, and copy metadata using the `[MetadataConverter](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/convert/metadataConverter.ts)` class. Because we’re dealing with files here, the components must be source-backed to perform the operation.

```
import {
    MetadataConverter,
    MetadataResolver
} from '@salesforce/source-deploy-retrieve'

const resolver = new MetadataResolver();
const converter = new MetadataConverter();

(async () {
    // sfdx force:source:convert
    // resolve a source format package and convert
    const components = resolver.getComponentsFromPath('/path/to/force-app');
    await converter.convert(components, 'metadata', {
        type: 'directory',
        outputDirectory: '/path/to/output',
        packageName: 'MetadataFormatPackage'
    });

    // sfdx force:mdapi:convert
    // resolve a metadata format package and convert
    const components = resolver.getComponentsFromPath('/path/to/force-app');
    await converter.convert(components, 'source', {
        type: 'directory',
        outputDirectory: '/path/to/output',
        packageName: 'SourceFormatPackage'
    });
})();
```

🛠🧽 _Most of this code lives in the `convert` module and makes assumptions that file conversion between the two formats is happening. This is a relic that never was addressed but should be, because it’s reasonable to want to copy files without the conversion process. Think of the CLI mdapi deploy and mdapi retrieve commands - these don’t do anything special with conversion regarding files. We might look into renaming exports to not assume conversion is happening and update the API to allow conversion to be optional._

### The conversion pipeline

When `convert` is called, the method prepares the inputs for setting up the conversion pipeline. The pipeline consists of chaining three custom NodeJS stream, one for each stage of the copy operation. To more deeply understand what is happening in the conversion process, it’s recommended to familiarize yourself with streaming concepts and the NodeJS API. See [Stream NodeJS documentation](https://nodejs.org/api/stream.html) and [Understanding Streams in NodeJS](https://nodesource.com/blog/understanding-streams-in-nodejs/).

#### ComponentReader

The reader is fairly simple, it takes a collection of source components and implements the stream API to push them out one-by-one.

🧽 _When this aspect of the library was first written,_ `Readable.from(iterable)` _was not yet available. This simple API could probably replace the_ `ComponentReader`_._

#### ComponentConverter

Here is where file transformation is done, but without being written to the destination yet. Similar to how source resolution uses adapters to determine how to construct components for a type (see [The resolver constructs components based…](#resolving-from-metadata-files)), conversion uses `MetadataTransformer` implementations to describe the transformations. As you might guess, types are assigned a transformer, if they need one, in their metadata registry definition, otherwise the default one is used. Each transformer implements a `toSourceFormat` and a `toMetadataFormat` method, which are called by the `ComponentConverter` based on what the target format is. The methods will return a collection of `WriteInfo` objects, which as we’ve been touching on are “descriptions” of how to write a given file.

Let’s say we’re converting a Layout from source format to metadata format. The write infos returned would look something like this:

```
const xmlFile = component.xml // path/to/source/MyLayout.layout-meta.xml
return [
   {
        // this is a Readable stream of the file's contents
        source: component.tree.stream(xmlFile),
        output: '/path/to/destination/MyLayout.layout'
   }
]
```

notice how we are stripping the `-meta.xml` suffix with the returned write info. This is essentially what’s happening in the `DefaultMetadataTransformer`. Once the converter has collected the write infos for a component, it pushes them to the write stage.

📝 _In a perfect world, no transformation of metadata files would be necessary. This aspect exists because that’s how SFDX was designed. Having a tooling client do fancy things to files is prone to error and consistency across other tools when the API should be returning files in a source friendly format to begin with. Just like the source adapters, CAREFULLY CAREFULLY consider if another transformer needs to be created — the right answer is likely NO. We don’t want to create special logic for any more types._

#### ComponentWriter

A `ComponentWriter` is responsible for taking the write infos created in the previous stage and using them to finally write files to a destination. The library relies on two different implementations of a writer:

- `StandardWriter` - Pipes a write info’s readable source to a NodeJS `fs.createWriteStream` writable, saving the contents of the file to the output location on disk.
- `ZipWriter` - Pipes a write info’s readable source into a zip archive. This archive can either be written to disk or built in-memory, the latter of which is used for deploy operations as an optimization.

The strategies used here are consciously attempting to reduce I/O and memory utilization as much as possible, and we do so with the help of the NodeJS streams API again. For instance, having the zip buffer built right in memory for a future deploy operation helps with this. Before, we were copying files to disk, then zipping those files and writing the result to disk, and then finally reloading the zip back into memory. This can be expensive on slower machines and grows a bit fast regarding time/space complexity.

#### ConvertContext

If you’ve been examining the code, you may have noticed the component converter holds on to something called a `ConvertContext`. This object is meant to be used as a “global state” of sorts over the course of a single conversion. Transformers can access this object in their implementation to save state and establish context of previous work they have already completed through subsequent calls. The state is stored in objects that extend `ConvertTransactionFinalizer`. A convert context has an instance of each of these finalizers to represent a section of state. Different scenarios may depend on different shapes of state, so we use these objects to isolate those states.

Once finalizers have state data set, it needs to be processed at the end of the convert. The metadata converter implements the `_flush()` method, which is defined by the NodeJS streaming API to run any other final logic after a stream has been signaled as finished, or in our terms no more components are to be processed. This is where we call the `finalize()` methods of each convert transaction finalizer to push any leftover write infos that need to be created from the state.

In less general terms, this concept was created out of necessity to support converting decomposed components like CustomObjects. When processing a CustomObject, we need to combine the contents of all of its files, which are components themselves, into a single file for deployment. If we are processing a CustomField in the pipeline, we don’t want to tell the component writer to write a file just yet because we’re still waiting on any other child components of the same object to be included in the file. So instead of returning a write info, we save the same information in the `RecompositionFinalizer`’s state. Once all components of the convert have been processed, `RecompositionFinalizer.prototype.finalize()` is called to combine all of an object’s child components into a single write info, and to push that to the component writer.

#### In [decomposedMetadataTransformer.ts](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/convert/transformers/decomposedMetadataTransformer.ts)

```
// in decomposedMetadataTransformer.ts

public async toMetadataFormat(component: SourceComponent): Promise<WriteInfo[]> {
    // If the component we're processing has a parent (like CustomObject),
    // it's assumed to be a child (like CustomField)
    if (component.parent) {
        this.context.recomposition.setState((state) => {
            if (state[parentName]) {
                // Add the child component if we already have an entry for parent
                state[parentName].children.add(component);
            } else {
                // Create a new entry in the state, mapping the parent component
                // to an array of children to be rolled up in the result
                state[parentName] = {
                    component: component.parent,
                    children: new ComponentSet([component], this.registry),
                };
            }
        });
    }

    // ... other code

    // Don't return any write infos - we're not ready to write files yet!
    return []
}
```

#### In [convertContext.ts](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/convert/convertContext.ts)

```
class RecompositionFinalizer extends ConvertTransactionFinalizer<RecompositionState> {
  protected _state: RecompositionState = {};

  public async finalize(): Promise<WriterFormat[]> {
    const writerData: WriterFormat[] = [];

    for (const { component: parent, children } of Object.values(this.state)) {
      // Combine the children with the parent to create one XML object
      const recomposedXmlObj = await this.recompose(children, parent);
      writerData.push({
        component: parent,
        // Return one write info per CustomObject that is the combined result
        writeInfos: [
          {
            source: new JsToXml(recomposedXmlObj),
            output: join(parent.type.directoryName, `${parent.fullName}.${parent.type.suffix}`),
          },
        ],
      });
    }

    return writerData;
  }
  // ...
}

```

📝 _Does this sound a bit overcomplicated? I think it does. These are the kinds of things we have to create though to accommodate the fact that we committed to the client being responsible for fancy file transformations. If the server returned a CustomObject already in an “IDE editing/git friendly“ format we would not have to do this._

## Component Merging

### Overview

Component merging refers to replacing the files of one component with the files of another that share the same fullName and type pair. This technique is used when retrieving components to an SFDX project that has local versions of the same components. In effect, we can overwrite a component’s files in a project with those from a matching component’s files from the retrieved zip archive.

The following is an example of what a retrieve call is more or less doing under the hood when extracting components to an existing project:

```
import {
    MetadataConverter,
    MetadataResolver,
    ZipTreeContainer
} from '@salesforce/source-deploy-retrieve'

(async () => {
   // Resolving components in the zip file
   const zipBuffer = getZipBuffer();
   const zipTree = await ZipTreeContainer.create(zipBuffer);
   const zipResolver = new MetadataResolver(undefined, zipTree);
   const zipComponents = zipResolver.getComponentsFromPath('.')

   // Resolving components in SFDX project
   const resolver = new MetadataResolver();
   const forceAppComponents = resolver.getComponentsFromPath('/path/to/force-app');
   const testAppComponents = resolver.getComponentsFromPath('/path/to/test-app');

   const converter = new MetadataConverter();
   const result = await converter.convert(zipComponents, 'source', {
        type: 'merge',
        mergeWith: packageDirComponents,
        // If a component can't be merged, put it here by default
        defaultDirectory: '/path/to/force-app'
   });
})();
```

SDR does not have an abstraction of an SFDX package directory. The goal at first was to come up with the underlying concept of replacing a component’s files with another matching component’s, rather than be confined to the idea of a package directory. **If you find yourself asking “how do multiple package directories work”, component merging is the answer. If you resolve components in every package directory of a project and utilize that result when performing a merge, you are in effect handling the multiple package directory scenario.** This doesn’t mean we _can’t_ introduce a package directory abstraction into the library if it proves to be useful however.

### **CustomObjects across multiple package directories**

Component merging also handles the scenario where we split a CustomObject across multiple package directories. For instance, one package has all the custom fields, while another contains the object itself. When we retrieve the CustomObject from the org, the SFDX behavior is to put the fields in one package directory, and the rest of the object in another.

Let’s say in this scenario the object we’re working with is MyObj\_\_c

- Resolve components across every package directory in the project
- Two source-backed components representing the same fullName and type pair will be resolved, one for the group of fields, one for the object itself. The library essentially interprets it as two versions of the same component
- Components pass through the conversion pipeline with the merge option specified
- Even though they map to the same component, each copy of it is passed through the `DecomposedMetadataTransformer`
- Since each copy has different components in it (CustomFields in one, other stuff in other), the transformer will know how to set the output of each write info for the component it’s actually converting, which itself is fully composed.

## Component Sets

**Module:** <https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/collections>

### Overview

Oftentimes we need to work with a unique collection of components. A `ComponentSet` automatically de-dupes components and allows us to test whether or not a particular component is a member of a set. They also provide convenience methods that wrap the other functionality of the library, making it the easiest entry point for the most common use cases.

### Creating a set

Component sets key components using their fullName and type id, i.e. only one pair will ever be present in the set. This implies that anything that conforms to the `MetadataComponent` interface can be added to a set. `SourceComponent`s in fact have particular logic on how they are stored. While only one fullName and type pair can be present in a set, multiple source-backed components can map to the same pair under-the-hood. This is how splitting a CustomObject across multiple package directories is achieved - by treating each version of the component as a separate source-backed component that points to the same fullName and type pair in a set. When component merging happens, the conversion logic is able to combine the source components belonging to the same pair.

Let’s look at some examples of adding components and testing membership:

```
import {
    ComponentSet,
    MetadataResolver
} from '@salesforce/source-deploy-retrieve'

const set = new ComponentSet();
set.add({ fullName: 'MyClass', type: 'ApexClass' });
set.add({ fullName: 'MyLayout', type: 'Layout' });
set.size // => 2
set.add({ fullName: 'MyClass', type: 'ApexClass' });
set.size // => 2

const resolver = new MetadataResolver();
const mixedComponentTypes = new ComponentSet([
    { fullName: 'MyLayout', type: 'Layout' },
    { fullName: 'MyComponent', type: 'LightningComponentBundle' }
]);

const [myClass] = resolver.getComponentsFromPath('/path/to/classes/MyClass.cls');
mixedComponentTypes.add(myClass);
mixedComponentTypes.size; // => 3
mixedComponentTypes.has({ fullName: 'MyClass', type: 'ApexClass' }); // => true
```

### **Initializing a set from metadata files**

Up to this point, we have demonstrated resolving source-backed components using the `MetadataResolver`. Another option is to use the `fromSource` static initializer, which wraps the resolver, calls it, adds the result to a new set, and returns that set. This is often more convenient than constructing things yourself to produce the same result. The reason why the library encourages either way to resolve source-backed components is because there may be some slight trade-offs depending on which is used. Constructing a component set adds some overhead due to the work of ensuring uniqueness, but it’s very possible that it’s a tolerable/negligible amount of extra time for a consumer. Therefore, the recommendation is as follows:

- Use a component set initializer to resolve components if you intend to perform a common operation that requires a unique collection - deploying, retrieving, package xml generation, etc
- Use the resolver directly if you purely want to do some component analysis that doesn’t require a unique collection

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

const fromOnePath = ComponentSet.fromSource('/path/to/force-app');

// Resolve components from each path
const fromMultiplePaths = ComponentSet.fromSource([
   '/path/to/force-app',
   '/path/to/test-app',
   '/path/to/helper/main/default/classes'
]);

(async () => {
    // Resolve all Layout components in the zip file
    const zipTree = await ZipTreeContainer.create('/path/to/package.zip');
    const filter = new ComponentSet([{ fullName: '*', type: 'Layout' }]);
    const withOptions = ComponentSet.fromSource({
        fsPaths: ['.'],
        tree: zipTree,
        include: filter
    });
})();
```

### **Initializing a set from a manifest file**

Similar to how `fromSource` is a wrapper for the source resolver, `fromManifest` is a wrapper for the `ManifestResolver`. By default it does not add source-backed components, but using an options object we can use the resolved manifest as a filter for resolving them. An admittedly tricky aspect of this initializer is how to behave when a wildcard member is encountered in the file. These are the scenarios along with sub-bulleted reasons why they exist:

- If not resolving source, add the wildcard as a component to the set by default
  - When performing a retrieve independent of a project context
  - To accurately express the contents of the manifest file
- If resolving source, do NOT add the wildcard as a component to the set by default
  - When deploying. We cannot deploy a literal wildcard
  - When only wanting to use the wildcard as a means to filter components as a particular type, without expressing itself as a component
- If resolving source, add the wildcard as a component to the set with `forceAddWildcard: true`
  - When retrieving in the context of a project. We want every component of the type in an org, as well as to resolve any source-backed ones in the project
  - When wanting to use the wildcard as not only a filter when resolving source components, but also to express it as a component itself

Here are examples of the above scenarios:

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

/**
 * /path/to/package.xml
 *
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>TestPropertyController</members>
        <members>TestSampleDataController</members>
        <name>ApexClass</name>
    </types>
    <types>
        <members>Broker__c</members>
        <name>CustomObject</members>
    </types>
    <types>
        <members>*</members>
        <name>ApexTrigger</members>
    </types>
    <version>50.0</version>
</Package>
*/

(async () => {
    // Resolve non-source-backed components from the manifest
    const simple = await ComponentSet.fromManifest('/path/to/package.xml');
    simple.size // => 4 (wildcard member is added as its own component)


    // Resolve source-backed components with a manifest
    const manifestWithSource = await ComponentSet.fromManifest({
        manifestPath: '/path/to/package.xml',
        resolveSourcePaths: ['/path/to/force-app', '/path/to/force-app-2']
    });
    manifest.size // => 6 (assume 2 triggers in force-app, 1 trigger in force-app-2)


    // Same as previous example, but add the wildcard as its own component
    const manifestWithSource = await ComponentSet.fromManifest({
        manifestPath: '/path/to/package.xml',
        resolveSourcePaths: ['/path/to/force-app', '/path/to/force-app-2'],
        forceAddWildcards: true
    });
    manifest.size // => 7 (including { fullName: '*', type: 'ApexTrigger' } now)
})();
```

### Lazy pipeline methods

Component sets contain similar methods to those found on JavaScript Arrays, such as `map` and `filter`, as well as others like `first()`, `find()`, and `filter()`. These are obtained from extending the `LazyCollection` class. The only key difference with arrays is that these use iterators to lazily process components, meaning that components will pass through an entire chain before the previous component.

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

// Get paths to all of the classes with "Test" in the name
const testClassPaths = ComponentSet
    .fromSource('/path/to/force-app')
    .filter({ fullName } => fullName.includes('Test'))
    .map({ content } => content)
    .toArray();
```

## Deploying and Retrieving

**Module:** <https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/client>

### Overview

The order in which we’ve examined the concepts up to this point has been intentional. They are the building blocks leading up to the core use case of the library: deploying and retrieving. For a deploy, we must resolve source-backed components, then convert them into metadata format, write their files to a zip file, and finally send it to the org using the Metadata API. For a retrieve, we must resolve a mix of source-backed and non-source-backed components to make the Metadata API request, and once it finishes we resolve the components in the zip, convert them to source format, and finally copy them to a destination.

Metadata API deploys and retrieves are asynchronous operations. Once a request has been made, the status of the operation needs to be polled to determine whether or not the request has finished processing. This lifecycle is encapsulated with the `MetadataApiDeploy` and `MetadataApiRetrieve` classes — one instance is meant to map to one operation. They expose useful methods to process the lifecycle and make other requests, which will be illustrated later. These both extend `MetadataTransfer` in order to share common functionality such as polling.

### Establishing an org connection

Before we can perform either operation, we must establish a connection to an org. The library utilizes [sfdx-core](https://www.npmjs.com/package/@salesforce/core) connection objects to do. Currently there are two options when using SDR — either the consumer supplies a connection instance themselves or they pass an org username. The former requires authentication to have been persisted in `~/.sfdx` at some point prior. This is typically done by authorizing an org through the CLI or the VS Code extensions.

```
import { AuthInfo, Connection } from '@salesforce/core'

(async () => {
   // when passing only a username to deploy/retrieve operations, this
   // is happening under the hood
   const connection = await Connection.create({
        authInfo: await AuthInfo.create({
            // requires having already authenticated to this org
            username: 'user@example.com'
        })
   });
})();
```

See [Connection](https://forcedotcom.github.io/sfdx-core/classes/connection.html) in the API documentation for a more comprehensive overview of the object and how to use it. If a consumer is interested in authenticating an org outside of these two tools or customizing a Connection object, refer to that documentation.

### Deploying

The simplest way to kick off a new deploy is through a component set. `ComponentSet.prototype.deploy()` takes every source-backed component in the set and starts a new deploy operation with the target org. It returns a promise that resolves a new `MetadataApiDeploy`. \*\*\*\* Technically if nothing goes wrong with the deployment, there is nothing more to do. Naturally though we’d like to monitor the progress and process the result. We can do this by attaching a listener to the update event and call `pollStatus()` to wait for the operation to finish.

📝 _Keep in mind that when the_ `deploy()` _promise resolves, it does NOT mean the deploy has finished. It means the request has been sent to the org. Remember, these are asynchronous operations._

#### Deploy with a source path

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

(async () => {
    // Deploy every component in the classes folder
    const deploy = await ComponentSet
        .fromSource('/path/to/force-app/main/default/classes')
        .deploy({ usernameOrConnection: 'user@example.com' });

    // Attach a listener to check the deploy status on each poll
    deploy.onUpdate(response => {
        const { status, numberComponentsDeployed, numberComponentsTotal } = response;
        const progress = `${numberComponentsDeployed}/${numberComponentsTotal}`;
        const message = `Status: ${status} Progress: ${progress}`;
    });

    // Wait for polling to finish and get the DeployResult object
    const result = await deploy.pollStatus();

    // Output each file along with its state change of the deployment
    console.log(result.getFileResponses());
})();
```

#### Deploy with a manifest file

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

(async () => {
    // Collect all components that are members of the manifest across
    // two different package directories
    const set = await ComponentSet.fromManifest({
        manifestPath: '/path/to/package.xml',
        resolveSourcePaths: [
            '/path/to/force-app',
            '/path/to/force-app-2'
        ]
    });

    // Start a deploy with the components
    const deploy = await set.deploy({ usernameOrConnection: 'user@example.com' });

    // Attach a listener to check the deploy status on each poll
    deploy.onUpdate(response => {
        const { status, numberComponentsDeployed, numberComponentsTotal } = response;
        const progress = `${numberComponentsDeployed}/${numberComponentsTotal}`;
        const message = `Status: ${status} Progress: ${progress}`;
        console.log(message);
    });

    // Wait for polling to finish and get the DeployResult object
    const result = await deploy.pollStatus();

    // Output each file along with its state change of the deployment
    console.log(result.getFileResponses());
})();
```

#### Canceling a deploy

The Metadata API supports canceling a deploy in progress, and that is exposed through the `cancel()` method on the transfer object. Cancelations are also asynchronous operations - we need to poll to monitor when a cancelation actually finishes.

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

(async () => {
    const deploy = await ComponentSet
        .fromSource('/path/to/force-app')
        .deploy({ usernameOrConnection: 'user@example.com' });

    deploy.onUpdate(({ status }) => console.log(`Status: ${status}`));

    // send a cancel request to the org
    await deploy.cancel();

    // Wait until the cancelation finishes
    const result = await deploy.pollStatus();

    if (result.response.status === RequestStatus.Canceled) {
        console.log('The deploy operation was canceled');
    }
})();
```

#### Make requests with an existing deploy

If a deploy was started by some other client or routine, as long as we have the deploy ID we can still make requests to monitor the status or cancel the operation. This is done by constructing a `MetadataApiDeploy` object with the ID as an option.

```
import { MetadataApiDeploy } from '@salesforce/source-deploy-retrieve'

(async () => {
    const deploy = new MetadataApiDeploy({
        id: '00t12345678',
        usernameOrConnection: 'user@example.com'
    });

    // check the status once without polling
    const { status } = await deploy.checkStatus();

    let message;

    switch (status) {
        case RequestStatus.Succeeded:
            message = 'Deploy has finished successfully';
            break;
        case RequestStatus.Failed:
            message = 'Deploy failed';
            break;
        case RequestStatus.Canceled:
            message = 'Deploy was canceled';
            break;
        default:
            message = 'Deploy is still in progress';
    }
})();
```

### Retrieving

The simplest way to kick off a new retrieve is through a component set. `ComponentSet.prototype.retrieve()` will request every fullName and type pair in the set to be retrieved from the org to the specified `output` path. In order to have the components extracted to their destination, we are required to call the `pollStatus()` method. This will wait until the retrieve has finished and then convert and extract the files.

We also have the option of merging components that are retrieved in the org with those that are present in the set. **Merging is required when retrieving existing components in an SFDX project**. See [Component Merging](#component-merging) for more information about the concept. When the option `merge: true` is set, the files of the retrieved components are written to the locations of the files of the source-backed components in the set. For any non-source-backed components in the set, or if `merge: false`, these files are by default copied to the destination specified with the `output` option.

📝 _Keep in mind that when the_ `retrieve()` _promise resolves, it does NOT mean the retrieve has finished. It means the request has been sent to the org. Remember - these are asynchronous operations._

#### Retrieve with a source path

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

(async () => {
    // Retrieve every component in the classes folder to the same location
    const retrieve = await ComponentSet
        .fromSource('/path/to/force-app/main/default/classes')
        .retrieve({
            usernameOrConnection: 'user@example.com',
            // default location if retrieved component doesn't match with one in set
            output: '/path/to/force-app',
            merge: true
        });

    // Attach a listener to check the retrieve status on each poll
    retrieve.onUpdate(({ status }) => console.log(`Status: ${status}`));

    // Wait for polling to finish and get the RetrieveResult object
    const result = await deploy.pollStatus();

    // Output each retrieved file
    console.log(result.getFileResponses());
})();
```

#### Retrieve with a manifest file

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

(async () => {
    // Collect all components that are members of the manifest across
    // two different package directories
    const set = await ComponentSet.fromManifest({
        manifestPath: '/path/to/package.xml',
        resolveSourcePaths: [
            '/path/to/force-app',
            '/path/to/test-app'
        ],
        // We want to retrieve everything in the org as well,
        // see the section on initializing a set from a manifest file
        forceAddWildcards: true
    })

    // Start a retrieve with the components
    const retrieve = await set.retrieve({
        usernameOrConnection: 'user@example.com',
        // default location if retrieved component doesn't match with one in set
        output: '/path/to/force-app',
        merge: true
    });

    // Attach a listener to check the retrieve status on each poll
    retrieve.onUpdate(({ status }) => console.log(`Status: ${status}`));

    // Wait for polling to finish and get the RetrieveResult object
    const result = await retrieve.pollStatus();

    // Output each retrieved file
    console.log(result.getFileResponses());
})();
```

#### Canceling a retrieve

Unlike deploys, there isn’t a mechanism for signaling a retrieve cancelation with the Metadata API. The library will simply break any potential polling of the retrieved status, and that is exposed through the `cancel()` method on the transfer object.

```
import { ComponentSet } from '@salesforce/source-deploy-retrieve'

(async () => {
    const retrieve = await ComponentSet
        .fromSource('/path/to/force-app')
        .retrieve({
            usernameOrConnection: 'user@example.com'
            output: '/path/to/retrieve/output'
        });

    retrieve.onUpdate(({ status }) => console.log(`Status: ${status}`));

    // Start polling for the retrieve result
    retrieve.pollStatus().then(result => {
        if (result.response.status === RequestStatus.Canceled) {
            console.log('The retrieve operation was canceled');
        }
    });

    // stop polling for the retrieve result
    await retrieve.cancel();
})();
```

#### Make requests with an existing retrieve

If a retrieve was started by some other client or routine, as long as we have the retrieve ID we can still make requests to monitor the status or cancel the operation. This is done by constructing a `MetadataApiRetrieve` object with the ID as an option.

```
import { MetadataApiRetrieve } from '@salesforce/source-deploy-retrieve'

(async () => {
    const retrieve = new MetadataApiRetrieve({
        id: '00t12345678',
        usernameOrConnection: 'user@example.com',
        output: '/path/to/retrieve/output'
    });

    // Wait for the existing retrieve to finish, and then extract the components
    const result = await retrieve.pollStatus();

    console.result(result.getFileResponses());
})();
```

## Further Examples

For more code snippet examples similar to those found here, see the [examples](https://github.com/forcedotcom/source-deploy-retrieve/tree/main/examples) folder of the repository.
