import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface Command {
  name: string;
  id: string;
}

interface Hotkey {
  key: string;
  commandID: string;
}

interface Settings {
  hotkeys: Hotkey[];
}

const defaultHotkeys: Hotkey[] = [
  { key: 'h', commandID: 'editor:focus-left' },
  { key: 'j', commandID: 'editor:focus-bottom' },
  { key: 'k', commandID: 'editor:focus-top' },
  { key: 'l', commandID: 'editor:focus-right' },
];

export default class LeaderHotkeysPlugin extends Plugin {
  public settings: Settings;

  private leaderPending: boolean;
  private cmEditors: CodeMirror.Editor[];

  public async onload(): Promise<void> {
    this.settings = (await this.loadData()) || { hotkeys: defaultHotkeys };

    this.cmEditors = [];
    this.registerEvent(
      this.app.on('codemirror', (cm: CodeMirror.Editor) => {
        this.cmEditors.push(cm);
        cm.on('keydown', this.handleKeyDown);
      }),
    );

    this.addCommand({
      id: 'leader',
      name: 'Leader key',
      hotkeys: [
        {
          modifiers: ['Mod'],
          key: 'b',
        },
      ],
      callback: () => {
        console.debug('Leader pressed...');
        this.leaderPending = true;
      },
    });

    this.addSettingTab(new LeaderPluginSettingsTab(this.app, this));
  }

  public onunload(): void {
    this.cmEditors.forEach((cm) => {
      cm.off('keydown', this.handleKeyDown);
    });
  }

  private readonly handleKeyDown = (
    cm: CodeMirror.Editor,
    event: KeyboardEvent,
  ): void => {
    if (!this.leaderPending) {
      return;
    }

    let commandFound = false;
    for (let i = 0; i < this.settings.hotkeys.length; i++) {
      if (this.settings.hotkeys[i].key === event.key) {
        (this.app as any).commands.executeCommandById(
          this.settings.hotkeys[i].commandID,
        );
        event.preventDefault();
        commandFound = true;
        break;
      }
    }

    if (!commandFound) {
      console.debug('cancelling leader');
    }

    this.leaderPending = false;
  };
}

class LeaderPluginSettingsTab extends PluginSettingTab {
  private readonly plugin: LeaderHotkeysPlugin;
  private readonly commands: Command[];
  private readonly currentLeader: string;

  private tempNewHotkey: string;
  private tempNewCommand: string;

  constructor(app: App, plugin: LeaderHotkeysPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.commands = this.generateCommandList(app);
    this.currentLeader = this.lookupCurrentLeader(app);
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Leader Hotkeys Plugin - Settings' });

    containerEl.createEl('p', {
      text:
        'The leader-hotkeys listed below are used by pressing a custom ' +
        'hotkey (called the leader), then releasing and pressing the key ' +
        'defined for a particular command. The leader hotkey can be ' +
        'configured in the Hotkeys settings page, and is currently bound to.' +
        this.currentLeader,
    });

    containerEl.createEl('h3', { text: 'Existing Hotkeys' });

    this.plugin.settings.hotkeys.forEach((configuredCommand) => {
      const { key, commandID } = configuredCommand;

      new Setting(containerEl)
        .addExtraButton((button) => {
          button
            .setIcon('cross')
            .setTooltip('Delete shortcut')
            .onClick(() => {
              this.deleteHotkeyFromSettings(key);
              this.display();
            });
          button.extraSettingsEl.addClass('leader-hotkeys-delete');
        })
        .addText((text) => {
          text.setValue(key).onChange((newKey) => {
            if (newKey === '') {
              return;
            }
            const isValid = this.validateNewHotkey(newKey);
            if (isValid) {
              this.updateHotkeyInSettings(key, newKey);
            }
          });
          text.inputEl.addClass('leader-hotkeys-key');
        })
        .addDropdown((dropdown) => {
          this.commands.forEach((command) => {
            dropdown.addOption(command.id, command.name);
          });
          dropdown.setValue(commandID).onChange((newCommand) => {
            this.updateHotkeyCommandInSettings(key, newCommand);
          });
          dropdown.selectEl.addClass('leader-hotkeys-command');
        });
    });

    containerEl.createEl('h3', { text: 'Create New Hotkey' });

    new Setting(containerEl)
      .addText((text) => {
        text.setPlaceholder('a').onChange((newKey) => {
          if (newKey === '') {
            return;
          }
          const isValid = this.validateNewHotkey(newKey);
          if (isValid) {
            this.tempNewHotkey = newKey;
          }
        });
        text.inputEl.addClass('leader-hotkeys-key');
      })
      .addDropdown((dropdown) => {
        dropdown.addOption('invalid-placeholder', 'Select a Command');
        this.commands.forEach((command) => {
          dropdown.addOption(command.id, command.name);
        });
        dropdown.onChange((newCommand) => {
          this.tempNewCommand = newCommand;
        });
        dropdown.selectEl.addClass('leader-hotkeys-command');
      });

    new Setting(containerEl).addButton((button) => {
      button.setButtonText('Save New Hotkey').onClick(() => {
        const isValid = this.validateNewHotkey(this.tempNewHotkey);
        if (isValid) {
          this.storeNewHotkeyInSettings();
          this.display();
        }
      });
    });
  }

  private readonly lookupCurrentLeader = (app: App): string => {
    for (const [key, value] of Object.entries((app as any).commands.commands)) {
      if (key !== 'leader-hotkeys-obsidian:leader') {
        continue;
      }

      return value.hotkeys
        .map(
          (hotkey: any): string =>
            hotkey.modifiers.join('+') + '+' + hotkey.key,
        )
        .join(' or ');
    }
  };

  private readonly generateCommandList = (app: App): Command[] => {
    const commands: Command[] = [];
    for (const [key, value] of Object.entries((app as any).commands.commands)) {
      commands.push({ name: value.name, id: value.id });
    }
    return commands;
  };

  private readonly validateNewHotkey = (value: string): boolean => {
    console.log(`Validating value: '${value}'`);
    if (value.length !== 1) {
      new Notice('Leader hotkeys may only be a single letter');
      return false;
    }

    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      if (this.plugin.settings.hotkeys[i].key === value) {
        new Notice(`Leader hotkey '${value}' is already in use`);
        return false;
      }
    }

    return true;
  };

  private readonly deleteHotkeyFromSettings = (key: string): void => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (hotkey.key !== key) {
        continue;
      }

      console.log(`Removing leader-hotkey ${key} at index ${i}`);
      this.plugin.settings.hotkeys.splice(i, 1);
    }
    this.plugin.saveData(this.plugin.settings);
  };

  private readonly updateHotkeyInSettings = (
    key: string,
    newKey: string,
  ): void => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (hotkey.key !== key) {
        continue;
      }

      console.log(`Updating leader-hotkey ${key} at index ${i} to ${newKey}`);
      hotkey.key = newKey;
      break;
    }
    this.plugin.saveData(this.plugin.settings);
  };

  private readonly updateHotkeyCommandInSettings = (
    key: string,
    newCommand: string,
  ): void => {
    for (let i = 0; i < this.plugin.settings.hotkeys.length; i++) {
      const hotkey = this.plugin.settings.hotkeys[i];
      if (hotkey.key !== key) {
        continue;
      }

      console.log(
        `Updating leader-hotkey command ${key} at index ${i} to ${newCommand}`,
      );
      hotkey.commandID = newCommand;
      break;
    }
    this.plugin.saveData(this.plugin.settings);
  };

  private readonly storeNewHotkeyInSettings = (): void => {
    console.log(
      `Adding leader-hotkey command ${this.tempNewHotkey} to ${this.tempNewCommand}`,
    );
    this.plugin.settings.hotkeys.push({
      key: this.tempNewHotkey,
      commandID: this.tempNewCommand,
    });
    this.plugin.saveData(this.plugin.settings);
    this.tempNewHotkey = '';
    this.tempNewCommand = '';
  };
}
