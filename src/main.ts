import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { head, filter, compact } from 'lodash';

export default class AdvancedNavigationPlugin extends Plugin {
  public async onload(): Promise<void> {
    this.addCommand({
      id: 'get-layout',
      name: 'Get Layout',
      callback: () => {
        console.log(this.app.workspace.activeLeaf);
      },
    });

    this.addCommand({
      id: 'focus-up',
      name: 'Focus up',
      callback: () => {
        (this.app as any).commands.executeCommandById('editor:focus-top');
      },
    });
    this.addCommand({
      id: 'focus-down',
      name: 'Focus down',
      callback: () => {
        (this.app as any).commands.executeCommandById('editor:focus-bottom');
      },
    });
    this.addCommand({
      id: 'focus-left',
      name: 'Focus left',
      callback: () => {
        (this.app as any).commands.executeCommandById('editor:focus-left');
      },
    });
    this.addCommand({
      id: 'focus-right',
      name: 'Focus right',
      callback: () => {
        (this.app as any).commands.executeCommandById('editor:focus-right');

        /*
        const mainLayout = this.app.workspace.getLayout().main;
        const enhancedMainLayout = newEnhancedViewState(mainLayout, undefined);
        if (enhancedMainLayout.viewType === 'leaf') {
          throw new Error('Unexpected leaf at main layout root');
        }
        console.log(enhancedMainLayout);
        const activeLeaf = enhancedMainLayout.getActive();
        console.log(activeLeaf.id);
        */

        // But should also think about:
        //   - moving into sidebars
        //   - switching tabs in sidebars
        //   - horizontal and vertical splits in main and sidebars
        // don't forget to filter out empty
      },
    });
  }
}

const newEnhancedViewState = (
  viewState: any,
  parent: SplitView | undefined,
): SplitView | EditorView => {
  switch (viewState.type) {
    case 'split':
      return new SplitView(
        viewState.id,
        viewState.type,
        viewState.direction,
        viewState.children,
        undefined,
      );
    case 'leaf':
      return new EditorView(
        viewState.id,
        viewState.type,
        viewState.active || false,
        viewState.pinned || false,
        viewState.group,
        viewState.state,
        parent,
      );
    default:
      throw new Error('Unexpected leaf type: ' + viewState.type);
  }
};

class SplitView {
  public id: string;
  public viewType: 'split';
  public direction: string;
  public children: (SplitView | EditorView)[];
  public parent: SplitView | undefined;

  constructor(
    id: string,
    viewType: string,
    direction: string,
    children: any[],
    parent: SplitView | undefined,
  ) {
    if (viewType !== 'split') {
      throw new Error('unexpected type in SplitView: ' + viewType);
    }
    this.viewType = 'split';

    this.id = id;
    this.direction = direction;
    this.children = children.map((child: any) => {
      return newEnhancedViewState(child, this);
    });
    this.parent = parent;
  }

  public getActive = (): EditorView | undefined => {
    return head(
      compact(
        this.children.map((child) => {
          if (child.viewType === 'leaf') {
            return child.active ? child : undefined;
          } else {
            return child.getActive();
          }
        }),
      ),
    );
  };
}

class EditorView {
  public id: string;
  public viewType: 'leaf';
  public active: boolean;
  public pinned: boolean;
  public group?: string;
  public state: LeafState;
  public parent: SplitView;

  constructor(
    id: string,
    viewType: string,
    active: boolean,
    pinned: boolean,
    group: string | undefined,
    state: any,
    parent: SplitView,
  ) {
    if (viewType !== 'leaf') {
      throw new Error('unexpected type in EditorView: ' + viewType);
    }
    this.viewType = 'leaf';

    this.id = id;
    this.active = active;
    this.pinned = pinned;
    this.group = group;
    this.state = new LeafState(state);
    this.parent = parent;
  }
}

class LeafState {
  private leafType: string;
  private file: string;
  private mode: 'source' | 'preview' | 'live';

  constructor(state: any) {
    if ('type' in state) {
      this.leafType = state.type;
    }
    if ('state' in state) {
      const subState = state.state;
      if ('file' in subState) {
        this.file = subState.file;
      }
      if ('mode' in subState) {
        this.mode = subState.mode;
      }
    }
  }
}
