/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { basename, join } from 'path';
import { parse } from 'fast-xml-parser';
import { get, getString, JsonMap } from '@salesforce/ts-types';
import { baseName, normalizeToArray, parseMetadataXml, trimUntil } from '../utils';
import { DEFAULT_PACKAGE_ROOT_SFDX } from '../common';
import { SfdxFileFormat } from '../convert';
import { MetadataType } from '../registry';
import { TypeInferenceError } from '../errors';
import { DestructiveChangesType } from '../collections';
import { filePathsFromMetadataComponent } from '../utils/filePathGenerator';
import { MetadataComponent, VirtualDirectory } from './types';
import { NodeFSTreeContainer, TreeContainer, VirtualTreeContainer } from './treeContainers';
import { ForceIgnore } from './forceIgnore';

export type ComponentProperties = {
  name: string;
  type: MetadataType;
  xml?: string;
  content?: string;
  parent?: SourceComponent;
  parentType?: MetadataType;
};

/**
 * Representation of a MetadataComponent in a file tree.
 */
export class SourceComponent implements MetadataComponent {
  public readonly name: string;
  public readonly type: MetadataType;
  public readonly xml?: string;
  public readonly parent?: SourceComponent;
  public parentType?: MetadataType;
  public content?: string;
  private treeContainer: TreeContainer;
  private forceIgnore: ForceIgnore;
  private markedForDelete = false;
  private destructiveChangesType: DestructiveChangesType;

  public constructor(
    props: ComponentProperties,
    tree: TreeContainer = new NodeFSTreeContainer(),
    forceIgnore = new ForceIgnore()
  ) {
    this.name = props.name;
    this.type = props.type;
    this.xml = props.xml;
    this.parent = props.parent;
    this.content = props.content;
    this.parentType = props.parentType;
    this.treeContainer = tree;
    this.forceIgnore = forceIgnore;
  }

  /**
   *
   * @param props component properties (at a minimum, name and type)
   * @param fs VirtualTree.  If not provided, one will be constructed based on the name/type of the props
   * @param forceIgnore
   * @returns SourceComponent
   */
  public static createVirtualComponent(
    props: ComponentProperties,
    fs?: VirtualDirectory[],
    forceIgnore?: ForceIgnore
  ): SourceComponent {
    const tree = fs
      ? new VirtualTreeContainer(fs)
      : VirtualTreeContainer.fromFilePaths(filePathsFromMetadataComponent({ fullName: props.name, type: props.type }));

    return new SourceComponent(props, tree, forceIgnore);
  }

  public walkContent(): string[] {
    const sources: string[] = [];
    if (this.content) {
      for (const fsPath of this.walk(this.content)) {
        if (fsPath !== this.xml) {
          sources.push(fsPath);
        }
      }
    }
    return sources;
  }
  /**
   * returns the children of a parent SourceComponent
   *
   * Ensures that the children of SourceComponent are valid child types.
   * Invalid child types can occur when projects are structured in an atypical way such as having
   * ApexClasses or Layouts within a CustomObject folder.
   *
   * @return SourceComponent[] containing valid children
   */
  public getChildren(): SourceComponent[] {
    if (!this.parent && this.type.children) {
      const children = this.content ? this.getDecomposedChildren(this.content) : this.getNonDecomposedChildren();

      const validChildTypes = this.type?.children ? Object.keys(this.type?.children?.types) : [];
      for (const child of children) {
        // Ensure only valid child types are included with the parent.
        if (!validChildTypes.includes(child.type?.id)) {
          const filePath = child.xml || child.content;
          throw new TypeInferenceError('error_unexpected_child_type', [filePath, this.type.name]);
        }
      }
      return children;
    }
    return [];
  }

  public async parseXml<T = JsonMap>(xmlFilePath?: string): Promise<T> {
    const xml = xmlFilePath ?? this.xml;
    if (xml) {
      const contents = await this.tree.readFile(xml);
      return this.parse<T>(contents.toString());
    }
    return {} as T;
  }

  public parseXmlSync<T = JsonMap>(xmlFilePath?: string): T {
    const xml = xmlFilePath ?? this.xml;
    if (xml) {
      const contents = this.tree.readFileSync(xml);
      return this.parse<T>(contents.toString());
    }
    return {} as T;
  }

  /**
   * will return this instance of the forceignore, or will create one if undefined
   *
   * @return ForceIgnore
   */
  public getForceIgnore(): ForceIgnore {
    if (this.forceIgnore) {
      return this.forceIgnore;
    } else {
      return ForceIgnore.findAndCreate(this.content);
    }
  }

  /**
   * As a performance enhancement, use the already parsed parent xml source
   * to return the child section of xml source. This is useful for non-decomposed
   * transformers where all child source components reference the parent's
   * xml file to prevent re-reading the same file multiple times.
   *
   * @param parentXml parsed parent XMl source as an object
   * @returns child section of the parent's xml
   */
  public parseFromParentXml<T = JsonMap>(parentXml: T): T {
    if (!this.parent) {
      return parentXml;
    }
    const children = normalizeToArray(
      get(parentXml, `${this.parent.type.name}.${this.type.xmlElementName || this.type.directoryName}`)
    ) as T[];
    return children.find((c) => getString(c, this.type.uniqueIdElement) === this.name);
  }

  public getPackageRelativePath(fsPath: string, format: SfdxFileFormat): string {
    return format === 'source'
      ? join(DEFAULT_PACKAGE_ROOT_SFDX, this.calculateRelativePath(fsPath))
      : this.calculateRelativePath(fsPath);
  }

  /**
   * @returns whether this component should be part of destructive changes.
   */
  public isMarkedForDelete(): boolean {
    return this.markedForDelete;
  }

  public getDestructiveChangesType(): DestructiveChangesType {
    return this.destructiveChangesType;
  }

  public setMarkedForDelete(destructiveChangeType?: DestructiveChangesType | boolean): void {
    if (destructiveChangeType === false) {
      this.markedForDelete = false;
      // unset destructiveChangesType if it was already set
      delete this.destructiveChangesType;
    } else {
      this.markedForDelete = true;
      // eslint-disable-next-line no-unused-expressions
      destructiveChangeType === DestructiveChangesType.PRE
        ? (this.destructiveChangesType = DestructiveChangesType.PRE)
        : (this.destructiveChangesType = DestructiveChangesType.POST);
    }
  }

  private calculateRelativePath(fsPath: string): string {
    const { directoryName, suffix, inFolder, folderType, folderContentType } = this.type;

    // if there isn't a suffix, assume this is a mixed content component that must
    // reside in the directoryName of its type. trimUntil maintains the folder structure
    // the file resides in for the new destination. This also applies to inFolder types:
    // (report, dashboard, emailTemplate, document) and their folder container types:
    // (reportFolder, dashboardFolder, emailFolder, documentFolder)
    if (!suffix || inFolder || folderContentType) {
      return trimUntil(fsPath, directoryName);
    }

    if (folderType) {
      // types like Territory2Model have child types inside them.  We have to preserve those folder structures
      if (this.parentType?.folderType && this.parentType?.folderType !== this.type.id) {
        return trimUntil(fsPath, this.parentType.directoryName);
      }
      return join(directoryName, this.fullName.split('/')[0], basename(fsPath));
    }
    return join(directoryName, basename(fsPath));
  }

  private parse<T = JsonMap>(contents: string): T {
    // include tag attributes and don't parse text node as number
    const parsed = parse(contents.toString(), {
      ignoreAttributes: false,
      parseNodeValue: false,
    }) as T;
    const [firstElement] = Object.keys(parsed);
    if (firstElement === this.type.name) {
      return parsed;
    } else if (this.parent) {
      return this.parseFromParentXml(parsed);
    } else {
      return parsed;
    }
  }

  private getDecomposedChildren(dirPath: string): SourceComponent[] {
    const children: SourceComponent[] = [];
    for (const fsPath of this.walk(dirPath)) {
      const childXml = parseMetadataXml(fsPath);
      const fileIsRootXml = childXml?.suffix === this.type.suffix;
      if (childXml && !fileIsRootXml) {
        // TODO: Log warning if missing child type definition
        const childTypeId = this.type.children.suffixes[childXml.suffix];
        const childComponent = new SourceComponent(
          {
            name: baseName(fsPath),
            type: this.type.children.types[childTypeId],
            xml: fsPath,
            parent: this,
          },
          this.treeContainer,
          this.forceIgnore
        );
        children.push(childComponent);
      }
    }
    return children;
  }

  // Get the children for non-decomposed types that have an xmlElementName
  // and uniqueIdElement defined in the registry.
  // E.g., CustomLabels, Workflows, SharingRules, AssignmentRules.
  private getNonDecomposedChildren(): SourceComponent[] {
    const parsed = this.parseXmlSync();
    const children: SourceComponent[] = [];
    for (const childTypeId of Object.keys(this.type.children.types)) {
      const childType = this.type.children.types[childTypeId];
      const uniqueIdElement = childType.uniqueIdElement;
      if (uniqueIdElement) {
        const xmlPathToChildren = `${this.type.name}.${childType.xmlElementName}`;
        const elements = normalizeToArray(get(parsed, xmlPathToChildren, []));
        const childComponents = elements.map((element) => {
          return new SourceComponent(
            {
              name: getString(element, uniqueIdElement),
              type: childType,
              xml: this.xml,
              parent: this,
            },
            this.treeContainer,
            this.forceIgnore
          );
        });
        children.push(...childComponents);
      }
    }
    return children;
  }

  private *walk(fsPath: string): IterableIterator<string> {
    if (!this.treeContainer.isDirectory(fsPath)) {
      yield fsPath;
    } else {
      for (const child of this.treeContainer.readDirectory(fsPath)) {
        const childPath = join(fsPath, child);
        if (this.forceIgnore.denies(childPath)) {
          continue;
        } else if (this.treeContainer.isDirectory(childPath)) {
          yield* this.walk(childPath);
        } else {
          yield childPath;
        }
      }
    }
  }

  public get fullName(): string {
    if (this.type.ignoreParsedFullName) {
      return this.type.name;
    }
    if (this.parent && this.type.ignoreParentName) {
      return this.name;
    } else {
      return `${this.parent ? `${this.parent.fullName}.` : ''}${this.name}`;
    }
  }

  public get tree(): TreeContainer {
    return this.treeContainer;
  }

  /**
   * Returns whether this component type is supported by the Metadata API
   * and therefore should have an entry added to the manifest.
   *
   * This is defined on the type in the registry. The type is required to
   * be in the registry for proper classification and for possible use in
   * decomposition/recomposition.
   *
   * Default value is true, so the only way to return false is to explicitly
   * set it in the registry as false.
   *
   * E.g., CustomFieldTranslation.
   */
  public get isAddressable(): boolean {
    return this.type.isAddressable !== false;
  }
}
