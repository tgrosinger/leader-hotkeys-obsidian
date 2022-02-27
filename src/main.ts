import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';

type Optional<T> = T | undefined | null;

class KeyPress {
  public static of(event: KeyboardEvent): KeyPress {
    const key = event.key;
    const shift = event.shiftKey;
    const meta = event.metaKey || event.ctrlKey;
    return new KeyPress(key, shift, meta);
  }

  public readonly key: string;
  public readonly meta: boolean;
  public readonly shift: boolean;

  constructor(key: string, shift: boolean, meta: boolean) {
    this.key = key;
    this.shift = shift;
    this.meta = meta;
  }

  public repr(): string {
    return `${this.meta ? '⌘' : ''}${this.shift ? '⇧' : ''}${this.key}`;
  }
}
class Hotkey {
  public sequence: KeyPress[];
  public commandID: string;
}

class TrieNode<T> {
  public children = new Map<string, TrieNode<T>>();
  public value: Optional<T>;

  public child(key: string): Optional<TrieNode<T>> {
    return this.children.get(key);
  }

  public addChild(key: string, child: TrieNode<T>): void {
    this.children.set(key, child);
  }

  public allLeaf(): TrieNode<T>[] {
    if (this.children.size === 0) {
      return [this];
    }

    let result: TrieNode<T>[] = [];

    this.children.forEach((child, key) => {
      result = result.concat(child.allLeaf());
    });

    return result;
  }
  public allValues(): T[] {
    return this.allLeaf().map((node) => node.value);
  }
  public isLeaf(): boolean {
    return this.children.size === 0;
  }
  public setValue(value: T): void {
    this.value = value;
  }
}

class KeymapTrie {
  private readonly root: TrieNode<Hotkey>;
  constructor(keymaps: Hotkey[]) {
    this.root = new TrieNode();

    for (const keymap of keymaps) {
      let lastSeenNode = this.root;
      for (const keyPress of keymap.sequence) {
        const key = keyPress.repr();
        const child = lastSeenNode.child(key) || new TrieNode();
        lastSeenNode.addChild(key, child);
        lastSeenNode = child;
      }
      lastSeenNode.setValue(keymap);
    }
  }

  public bestMatch(keyPresses: KeyPress[]): Optional<TrieNode<Hotkey>> {
    let lastNode = this.root;
    for (const keyPress of keyPresses) {
      const key = keyPress.repr();
      const child = lastNode.child(key);
      if (!child) {
        return null;
      }
      lastNode = child;
    }

    return lastNode;
  }
}

enum MatchingState {
  NoMatch,
  LeaderMatch,
  PartialMatch,
  FullMatch,
  ExitMatch,
}

class StateMachine {
  private readonly trie: KeymapTrie;
  private currentState: MatchingState;
  private keyPressBuffer: KeyPress[];
  private availableCommands: Hotkey[];

  constructor(hotkeys: Hotkey[]) {
    this.trie = new KeymapTrie(hotkeys);
    this.currentState = MatchingState.NoMatch;
    this.keyPressBuffer = [];
    this.availableCommands = [];
  }

  public advance(event: KeyboardEvent): MatchingState {
    const keypress = KeyPress.of(event);
    this.keyPressBuffer.push(keypress);

    switch (this.currentState) {
      // Start Matching
      case MatchingState.NoMatch:
        {
          const bestMatch = this.trie.bestMatch(this.keyPressBuffer);
          this.availableCommands = bestMatch ? bestMatch.allValues() : [];
          // No Match Logic
          if (!bestMatch) {
            this.clear();
          } else if (bestMatch.isLeaf()) {
            this.currentState = MatchingState.FullMatch;
          } else {
            this.currentState = MatchingState.LeaderMatch;
          }
        }
        return this.currentState;
      // Continue / Finish Matching
      case MatchingState.LeaderMatch:
      case MatchingState.PartialMatch:
        {
          const bestMatch = this.trie.bestMatch(this.keyPressBuffer);
          this.availableCommands = bestMatch ? bestMatch.allValues() : [];

          if (!bestMatch) {
            this.currentState = MatchingState.ExitMatch;
          } else if (bestMatch.isLeaf()) {
            this.currentState = MatchingState.FullMatch;
          } else {
            this.currentState = MatchingState.PartialMatch;
          }
        }
        return this.currentState;
      // Clear previous matching and rematch. this is a bit confusing. Can we do better?
      case MatchingState.FullMatch:
      case MatchingState.ExitMatch:
        this.clear();
        return this.advance(event);
    }
  }

  public getPartialMatchedKeymaps(): readonly Hotkey[] {
    return this.availableCommands;
  }

  public getFullyMatchedKeymap(): Optional<Hotkey> {
    const availableCommandLength = this.getPartialMatchedKeymaps().length;
    const isFullMatch = this.currentState === MatchingState.FullMatch;

    // Sanity checking.
    if (isFullMatch && availableCommandLength !== 1) {
      writeConsole(
        'State Machine in FullMatch state, but availableHotkeys.length contains more than 1 element. This is definitely a bug.',
      );
      return null;
    }

    if (isFullMatch && availableCommandLength === 1) {
      return this.availableCommands[0];
    }
    return null;
  }

  private clear(): void {
    this.currentState = MatchingState.NoMatch;
    this.keyPressBuffer = [];
    this.availableCommands = [];
  }
}

interface PluginSettings {
  hotkeys: Hotkey[];
}

export default class LeaderHotkeysPlugin extends Plugin {
  public settings: PluginSettings;
  private state: StateMachine;

  public async onload(): Promise<void> {
    writeConsole('Started Loading.');

    await this._loadSettings();
    await this._registerWorkspaceEvents();
    await this._registerLeaderKeymap();
    await this._registerPeripheralUIElements();

    writeConsole('Finished Loading.');
  }

  public onunload(): void {
    writeConsole('Unloading plugin.');
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const currentState = this.state.advance(event);
    switch (currentState) {
      case MatchingState.NoMatch:
        writeConsole(
          'An keypress resulted in a NoMatch state. Letting this event pass.',
        );
        return;

      case MatchingState.ExitMatch:
        event.preventDefault();
        writeConsole(
          'An keypress resulted in a ExitMatch. Exiting matching state.',
        );
        return;

      case MatchingState.LeaderMatch:
        event.preventDefault();
        writeConsole(
          'An keypress resulted in a LeaderMatch. Entering matching state.',
        );
        return;

      case MatchingState.PartialMatch:
        event.preventDefault();
        writeConsole(
          'An keypress resulted in a ParialMatch. Waiting for the rest of the key sequence.',
        );
        return;

      case MatchingState.FullMatch:
        event.preventDefault();
        writeConsole(
          'An keypress resulted in a FullMatch. Dispatching keymap.',
        );
        const keymap = this.state.getFullyMatchedKeymap();
        if (keymap) {
          const app = this.app as any;
          app.commands.executeCommandById(keymap.commandID);
        } else {
          writeConsole(
            'No keymap found for the full match. This is definitely a bug.',
          );
        }
        return;
    }
  };

  private async _loadSettings(): Promise<void> {
    writeConsole('Loading previously saved settings.');

    const savedSettings = await this.loadData();

    if (savedSettings) {
      writeConsole('Successfully loaded previous settings.');
    } else {
      writeConsole(
        'No saved settings were found, default ones will be used instead.',
      );
    }

    this.settings = savedSettings || defaultSettings;
    this.state = new StateMachine(this.settings.hotkeys);
  }

  private async _registerWorkspaceEvents(): Promise<void> {
    writeConsole('Registering necessary event callbacks');

    const workspaceContainer = this.app.workspace.containerEl;
    this.registerDomEvent(workspaceContainer, 'keydown', this.handleKeyDown);
    writeConsole('Registered workspace "keydown" event callbacks.');
  }

  private async _registerLeaderKeymap(): Promise<void> {
    writeConsole('Registering leaderKey command.');
    const leaderKeyCommand = {
      id: 'leader',
      name: 'Leader key',
      callback: () => {
        //	need something here.
      },
    };
    this.addCommand(leaderKeyCommand);
  }

  private async _registerPeripheralUIElements(): Promise<void> {
    writeConsole('Registering peripheral interface elements.');

    const leaderPluginSettingsTab = new LeaderPluginSettingsTab(this.app, this);
    this.addSettingTab(leaderPluginSettingsTab);
    writeConsole('Registered Setting Tab.');
  }
}

class SetHotkeyModal extends Modal {
  private readonly currentLeader: string;
  private readonly redraw: () => void;
  private readonly setNewKey: (
    key: string,
    meta: boolean,
    shift: boolean,
  ) => void;

  constructor(
    app: App,
    currentLeader: string,
    redraw: () => void,
    setNewKey: (newKey: string, meta: boolean, shift: boolean) => void,
  ) {
    super(app);
    this.currentLeader = currentLeader;
    this.redraw = redraw;
    this.setNewKey = setNewKey;
  }

  public onOpen = (): void => {
    const { contentEl } = this;

    const introText = document.createElement('p');
    introText.setText(
      `Press a key to use as the hotkey after the leader (${this.currentLeader}) is pressed...`,
    );

    contentEl.appendChild(introText);

    document.addEventListener('keydown', this.handleKeyDown);
  };

  public onClose = (): void => {
    document.removeEventListener('keydown', this.handleKeyDown);
    this.redraw();

    const { contentEl } = this;
    contentEl.empty();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (['Shift', 'Meta', 'Escape'].contains(event.key)) {
      return;
    }

    this.setNewKey(event.key, event.metaKey, event.shiftKey);
    this.close();
  };
}

interface Command {
  name: string;
  id: string;
}

class LeaderPluginSettingsTab extends PluginSettingTab {
  private readonly plugin: LeaderHotkeysPlugin;
  private commands: Command[];

  private tempNewHotkey: Hotkey;

  constructor(app: App, plugin: LeaderHotkeysPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    this.commands = this.generateCommandList(this.app);
    const { containerEl } = this;
    containerEl.empty();

    const currentLeader = this.lookupCurrentLeader(this.app);

    containerEl.createEl('h2', { text: 'Leader Hotkeys Plugin - Settings' });

    containerEl.createEl('p', {
      text:
        'The leader-hotkeys listed below are used by pressing a custom ' +
        'hotkey (called the leader), then releasing and pressing the key ' +
        'defined for a particular command. The leader hotkey can be ' +
        'configured in the Hotkeys settings page, and is currently bound to ' +
        currentLeader +
        '.',
    });

    containerEl.createEl('h3', { text: 'Existing Hotkeys' });

    this.plugin.settings.hotkeys.forEach((configuredCommand) => {
      const setting = new Setting(containerEl)
        .addDropdown((dropdown) => {
          this.commands.forEach((command) => {
            dropdown.addOption(command.id, command.name);
          });
          dropdown
            .setValue(configuredCommand.commandID)
            .onChange((newCommand) => {
              this.updateHotkeyCommandInSettings(configuredCommand, newCommand);
            });
          dropdown.selectEl.addClass('leader-hotkeys-command');
        })
        .addExtraButton((button) => {
          button
            .setIcon('cross')
            .setTooltip('Delete shortcut')
            .onClick(() => {
              this.deleteHotkeyFromSettings(configuredCommand);
              this.display();
            });
          button.extraSettingsEl.addClass('leader-hotkeys-delete');
        });

      setting.infoEl.remove();
      const settingControl = setting.settingEl.children[0];

      const prependText = document.createElement('span');
      prependText.addClass('leader-hotkeys-setting-prepend-text');
      prependText.setText(`Use ${currentLeader} followed by`);
      settingControl.insertBefore(prependText, settingControl.children[0]);

      const keySetter = document.createElement('kbd');
      keySetter.addClass('setting-hotkey');
      keySetter.setText(hotkeyToName(configuredCommand));
      keySetter.addEventListener('click', (e: Event) => {
        new SetHotkeyModal(
          this.app,
          currentLeader,
          () => {
            this.display();
          },
          (newKey: string, meta: boolean, shift: boolean) => {
            const isValid = this.validateNewHotkey(newKey, meta, shift);
            if (isValid) {
              this.updateHotkeyInSettings(
                configuredCommand,
                newKey,
                meta,
                shift,
              );
            }
          },
        ).open();
      });
      settingControl.insertBefore(keySetter, settingControl.children[1]);

      const appendText = document.createElement('span');
      appendText.addClass('leader-hotkeys-setting-append-text');
      appendText.setText('to');
      settingControl.insertBefore(appendText, settingControl.children[2]);
    });

    containerEl.createEl('h3', { text: 'Create New Hotkey' });

    const newHotkeySetting = new Setting(containerEl).addDropdown(
      (dropdown) => {
        dropdown.addOption('invalid-placeholder', 'Select a Command');
        this.commands.forEach((command) => {
          dropdown.addOption(command.id, command.name);
        });
        dropdown.onChange((newCommand) => {
          if (this.tempNewHotkey === undefined) {
            this.tempNewHotkey = newEmptyHotkey();
          }
          this.tempNewHotkey.commandID = newCommand;
        });
        dropdown.selectEl.addClass('leader-hotkeys-command');
      },
    );

    newHotkeySetting.infoEl.remove();
    const settingControl = newHotkeySetting.settingEl.children[0];

    const prependText = document.createElement('span');
    prependText.addClass('leader-hotkeys-setting-prepend-text');
    prependText.setText(`Use ${currentLeader} followed by`);
    settingControl.insertBefore(prependText, settingControl.children[0]);

    const keySetter = document.createElement('kbd');
    keySetter.addClass('setting-hotkey');
    keySetter.setText(hotkeyToName(this.tempNewHotkey));
    keySetter.addEventListener('click', (e: Event) => {
      new SetHotkeyModal(
        this.app,
        currentLeader,
        () => {
          this.display();
        },
        (newKey: string, meta: boolean, shift: boolean) => {
          if (this.tempNewHotkey === undefined) {
            this.tempNewHotkey = newEmptyHotkey();
          }
          this.tempNewHotkey.key = newKey;
          this.tempNewHotkey.meta = meta;
          this.tempNewHotkey.shift = shift;
        },
      ).open();
    });
    settingControl.insertBefore(keySetter, settingControl.children[1]);

    const appendText = document.createElement('span');
    appendText.addClass('leader-hotkeys-setting-append-text');
    appendText.setText('to');
    settingControl.insertBefore(appendText, settingControl.children[2]);

    new Setting(containerEl).addButton((button) => {
      button.setButtonText('Save New Hotkey').onClick(() => {
        const isValid = this.validateNewHotkey(
          this.tempNewHotkey.key,
          this.tempNewHotkey.meta,
          this.tempNewHotkey.shift,
        );
        if (isValid) {
          this.storeNewHotkeyInSettings();
          this.display();
        }
      });
    });
  }

  private readonly lookupCurrentLeader = (app: App): string => {
    const customKeys = (app as any).hotkeyManager.customKeys;
    if ('leader-hotkeys-obsidian:leader' in customKeys) {
      return customKeys['leader-hotkeys-obsidian:leader']
        .map(
          (hotkey: any): string =>
            hotkey.modifiers.join('+') + '+' + hotkey.key,
        )
        .join(' or ');
    }

    return 'Mod+b';
  };

  private readonly generateCommandList = (app: App): Command[] => {
    const commands: Command[] = [];
    for (const [key, value] of Object.entries((app as any).commands.commands)) {
      commands.push({ name: value.name, id: value.id });
    }
    return commands;
  };

  private readonly validateNewHotkey = (
    key: string,
    meta: boolean,
    shift: boolean,
  ): boolean => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (
        hotkey.key === key &&
        hotkey.meta === meta &&
        hotkey.shift === shift
      ) {
        const hotkeyName = hotkeyToName(hotkey);
        new Notice(`Leader hotkey '${hotkeyName}' is already in use`);
        return false;
      }
    }

    return true;
  };

  private readonly deleteHotkeyFromSettings = (
    existingHotkey: Hotkey,
  ): void => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (
        hotkey.key !== existingHotkey.key ||
        hotkey.meta !== existingHotkey.meta ||
        hotkey.shift !== existingHotkey.shift
      ) {
        continue;
      }

      console.debug(
        `Removing leader-hotkey ${hotkeyToName(existingHotkey)} at index ${i}`,
      );
      this.plugin.settings.hotkeys.splice(i, 1);
    }
    this.plugin.saveData(this.plugin.settings);
  };

  private readonly updateHotkeyInSettings = (
    existingHotkey: Hotkey,
    newKey: string,
    meta: boolean,
    shift: boolean,
  ): void => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (
        hotkey.key !== existingHotkey.key ||
        hotkey.meta !== existingHotkey.meta ||
        hotkey.shift !== existingHotkey.shift
      ) {
        continue;
      }

      console.debug(
        `Updating leader-hotkey ${hotkeyToName(
          existingHotkey,
        )} at index ${i} to ${newKey}`,
      );
      hotkey.key = newKey;
      hotkey.meta = meta;
      hotkey.shift = shift;
      break;
    }
    this.plugin.saveData(this.plugin.settings);
  };

  private readonly updateHotkeyCommandInSettings = (
    existingHotkey: Hotkey,
    newCommand: string,
  ): void => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (
        hotkey.key !== existingHotkey.key ||
        hotkey.meta !== existingHotkey.meta ||
        hotkey.shift !== existingHotkey.shift
      ) {
        continue;
      }

      console.debug(
        `Updating leader-hotkey command ${hotkeyToName(
          existingHotkey,
        )} at index ${i} to ${newCommand}`,
      );
      hotkey.commandID = newCommand;
      break;
    }
    this.plugin.saveData(this.plugin.settings);
  };

  private readonly storeNewHotkeyInSettings = (): void => {
    console.debug(
      `Adding leader-hotkey command ${this.tempNewHotkey} to ${this.tempNewHotkey.commandID}`,
    );
    this.plugin.settings.hotkeys.push(this.tempNewHotkey);
    this.plugin.saveData(this.plugin.settings);
    this.tempNewHotkey = newEmptyHotkey();
  };
}

const defaultHotkeys: Hotkey[] = [
  {
    sequence: [new KeyPress('b', false, true), new KeyPress('h', false, false)],
    commandID: 'editor:focus-left',
  },
  {
    sequence: [new KeyPress('b', false, true), new KeyPress('j', false, false)],
    commandID: 'editor:focus-bottom',
  },
  {
    sequence: [new KeyPress('b', false, true), new KeyPress('k', false, false)],
    commandID: 'editor:focus-top',
  },
  {
    sequence: [new KeyPress('b', false, true), new KeyPress('l', false, false)],
    commandID: 'editor:focus-right',
  },
  {
    sequence: [
      new KeyPress('q', false, true),
      new KeyPress('1', false, false),
      new KeyPress('2', false, false),
      new KeyPress('2', false, false),
    ],
    commandID: 'command-palette:open',
  },
];
const defaultSettings: PluginSettings = {
  hotkeys: defaultHotkeys,
};

const writeConsole = (message: string): void => {
  console.debug(` Leader Hotkeys: ${message}`);
};
const newEmptyHotkey = (): Hotkey => ({
  key: '',
  shift: false,
  meta: false,
  commandID: '',
});
const hotkeyToName = (hotkey: Hotkey): string => {
  if (hotkey === undefined || hotkey.key === '') {
    return '?';
  }
  const keyToUse = (() => {
    switch (hotkey.key) {
      case 'ArrowRight':
        return '→';
      case 'ArrowLeft':
        return '←';
      case 'ArrowDown':
        return '↓';
      case 'ArrowUp':
        return '↑';
      default:
        return hotkey.key;
    }
  })();
  return (
    (hotkey.meta ? 'meta+' : '') + (hotkey.shift ? 'shift+' : '') + keyToUse
  );
};
