import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'vscode';
import { AstResult, SastNode } from './results';
import { EXTENSION_NAME, SCAN_ID_KEY, HIGH_FILTER, MEDIUM_FILTER, LOW_FILTER, INFO_FILTER } from './constants';
import { getProperty } from './utils';
import { Logs } from './logs';

export enum IssueFilter {
  fileName = "fileName",
  severity = "severity",
  status = "status",
  language = "language"
}

export enum IssueLevel {
  high = "HIGH",
  medium = "MEDIUM",
  low = "LOW",
  info = "INFO",
  empty = ""
}

export class AstResultsProvider implements vscode.TreeDataProvider<TreeItem> {
  public issueFilter: IssueFilter = IssueFilter.severity;
  public issueLevel: IssueLevel[] = [IssueLevel.high, IssueLevel.medium];

  private _onDidChangeTreeData: EventEmitter<TreeItem | undefined> = new EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined> = this._onDidChangeTreeData.event;
  private scanId: string;
  private data: TreeItem[] | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logs: Logs,
    private readonly statusBarItem: vscode.StatusBarItem,
    private readonly diagnosticCollection: vscode.DiagnosticCollection) {
      this.initializeFilters();
      this.scanId = this.context.globalState.get(SCAN_ID_KEY, "");
      this.refreshData();
  }

  private showStatusBarItem() {
		this.statusBarItem.text = "$(sync~spin) Refreshing tree";
		this.statusBarItem.tooltip = "Checkmarx command is running";
		this.statusBarItem.show();
	}

	private hideStatusBarItem() {
		this.statusBarItem.text = EXTENSION_NAME;
		this.statusBarItem.tooltip = undefined;
		this.statusBarItem.command = undefined;
		this.statusBarItem.hide();
	}

  private async initializeFilters() {
    await vscode.commands.executeCommand('setContext',INFO_FILTER,false);
    await vscode.commands.executeCommand('setContext',LOW_FILTER,false);
    await vscode.commands.executeCommand('setContext',MEDIUM_FILTER,true);
    await vscode.commands.executeCommand('setContext',HIGH_FILTER,true);
  }

  refresh(): void {
    this.refreshData();
    this._onDidChangeTreeData.fire(undefined);
  }

  clean(): void {
		const resultJsonPath = path.join(__dirname, 'ast-results.json');
		if (fs.existsSync(resultJsonPath)) {
			fs.unlinkSync(resultJsonPath);
		}
    this.refreshData();
    this._onDidChangeTreeData.fire(undefined);
  }

  async refreshData(typeFilter?:string): Promise<void> {
    this.showStatusBarItem();
    
    // Used to check if the refresh is being called from a filter button
    if(typeFilter){
      var context = await this.context.globalState.get(typeFilter);
      // Change the selection value in the context
      await this.context.globalState.update(typeFilter,!context);
      await vscode.commands.executeCommand('setContext',typeFilter,!context);
    }
    this.data = this.generateTree().children;
    this.scanId = this.context.globalState.get(SCAN_ID_KEY, "");
    this._onDidChangeTreeData.fire(undefined);
    this.hideStatusBarItem();
  }

  generateTree(): TreeItem {
    const resultJsonPath = path.join(__dirname, 'ast-results.json');
    
    if (!fs.existsSync(resultJsonPath)) {
      this.diagnosticCollection.clear();
      return new TreeItem("", undefined, []);
    } 

    const jsonResults = JSON.parse(fs.readFileSync(resultJsonPath, 'utf-8'));

    const groups = ['type', this.issueFilter];
    return this.groupBy(jsonResults.results, groups);
  }

  groupBy(list: Object[], groups: string[]): TreeItem {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const map = new Map<string, vscode.Diagnostic[]>();
    const tree = new TreeItem(this.scanId, undefined, []);

    list.forEach(element => this.groupTree(element, folder, map, groups, tree));

    this.diagnosticCollection.clear();
    map.forEach((value, key) => this.diagnosticCollection.set(vscode.Uri.parse(key), value));
    
    return tree;
  }

  groupTree(rawObj: Object, folder: vscode.WorkspaceFolder | undefined, map: Map<string, vscode.Diagnostic[]>, groups: string[], tree: TreeItem) {
    const obj = new AstResult(rawObj);
    if (!obj) { return; } 
    const item = new TreeItem(obj.label, obj);
    // Verify the current severity fiters applied
    if (this.issueLevel.length>0) {
      // Filter only the results for the severity filters type
      if(this.issueLevel.includes(obj.getSeverity())){
        if (obj.sastNodes.length > 0) {this.createDiagnostic(obj.label, obj.getSeverityCode(), obj.sastNodes[0], folder, map);}
        const node = groups.reduce((previousValue: TreeItem, currentValue: string) => this.reduceGroups(obj, previousValue, currentValue), tree);
        node.children?.push(item);
      }
    }
    // If there is no severity filter no information should be stored in the tree
    else{
      new TreeItem("");
    }
    
  }

  createDiagnostic(label: string, severity: vscode.DiagnosticSeverity, node: SastNode, folder: vscode.WorkspaceFolder | undefined, map: Map<string, vscode.Diagnostic[]>) {
    if(!folder) {
      return;
    }
    const filePath = vscode.Uri.joinPath(folder!.uri, node.fileName).toString();
    // Needed because vscode uses zero based line number
    const column  = node.column > 0 ? +node.column - 1 : 1;
    const line    = node.line > 0 ? +node.line  - 1 : 1;
    let length    = column + node.length;
    const startPosition = new vscode.Position(line , column);
    const endPosition = new vscode.Position(line , length);
    const range = new vscode.Range(startPosition,endPosition);
    
    const diagnostic = new vscode.Diagnostic(range, label, severity);
    if (map.has(filePath)) {
      map.get(filePath)?.push(diagnostic);
    } else {
      map.set(filePath, [diagnostic]);
    }
  }

  reduceGroups(obj: Object, previousValue: TreeItem, currentValue: string) {
    const value = getProperty(obj, currentValue);
    if (!value) { return previousValue; }

    const tree = previousValue.children ? previousValue.children.find(item => (item.label === value)) : undefined;
    if (tree) {
      tree.setDescription();
      return tree;
    }

    const newTree = new TreeItem(value, undefined, []);
    previousValue.children?.push(newTree);
    return newTree;
  }

  getTreeItem(element: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: TreeItem | undefined): vscode.ProviderResult<TreeItem[]> {
    if (element === undefined) {
      return this.data;
    }
    return element.children;
  }
}

export class TreeItem extends vscode.TreeItem {
  children: TreeItem[] | undefined;
  result: AstResult | undefined;
  size: number;

  constructor(label: string, result?: AstResult, children?: TreeItem[]) {
    super(
      label,
      children === undefined ? vscode.TreeItemCollapsibleState.None :
        vscode.TreeItemCollapsibleState.Collapsed);
    this.result = result;
    this.size = 1;
    this.children = children;
    if (result) {
      this.iconPath =  result.getIcon();
    }
  };

  setDescription() {
    +this.size++;
    this.description = "" + this.size;
  }
}

