import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface Command {
  name: string;
  id: string;
}

interface Hotkey {
  key: string;
  commandID: string;
}
export default class LeaderHotkeysPlugin extends Plugin {
  private leaderPending: boolean;
  private cmEditors: CodeMirror.Editor[];

  public hotkeys: Hotkey[];

  public async onload(): Promise<void> {
    this.hotkeys = [];

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

    switch (event.key) {
      case 'j':
        (this.app as any).commands.executeCommandById('editor:focus-bottom');
        break;
      case 'k':
        (this.app as any).commands.executeCommandById('editor:focus-top');
        break;
      case 'h':
        (this.app as any).commands.executeCommandById('editor:focus-left');
        break;
      case 'l':
        (this.app as any).commands.executeCommandById('editor:focus-right');
        break;
      default:
        console.debug('cancelling leader');
        return;
    }

    this.leaderPending = false;
    event.preventDefault();
  };
}

class LeaderPluginSettingsTab extends PluginSettingTab {
  private readonly plugin: LeaderHotkeysPlugin;
  private readonly commands: Command[];
  private readonly currentLeader: string;

  constructor(app: App, plugin: LeaderHotkeysPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.commands = this.generateCommandList(app);
    this.currentLeader = this.lookupCurrentLeader(app);
  }

  private lookupCurrentLeader = (app: App): string => {
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

  private generateCommandList = (app: App): Command[] => {
    const commands: Command[] = [];
    for (const [key, value] of Object.entries((app as any).commands.commands)) {
      commands.push({ name: value.name, id: value.id });
    }
    return commands;
  };

  private validateNewHotkey = (value: string): boolean => {
    console.log(`Validating value: '${value}'`);
    if (value.length !== 1) {
      new Notice('Leader hotkeys may only be a single letter');
      return false;
    }

    for (let i = 0; i < this.plugin.hotkeys.length; i++) {
      if (this.plugin.hotkeys[i].key === value) {
        new Notice(`Leader hotkey '${value}' is already in use`);
        return false;
      }
    }

    return true;
  };

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

    const commands = [
      ['h', 'editor:focus-left'],
      ['j', 'editor:focus-bottom'],
      ['k', 'editor:focus-top'],
      ['l', 'editor:focus-right'],
    ];

    commands.map((command) => {
      const [key, commandName] = command;

      new Setting(containerEl)
        .addExtraButton((button) => {
          button
            .setIcon('cross')
            .setTooltip('Delete shortcut')
            .onClick(() => {
              console.log('should remove ' + commandName);
            });
          button.extraSettingsEl.addClass('leader-hotkeys-delete');
        })
        .addText((text) => {
          text.setValue(key).onChange((newTextValue) => {
            if (newTextValue === '') {
              return;
            }
            const isValid = this.validateNewHotkey(newTextValue);
            if (isValid) {
              console.log(`updating hotkey for ${key} to ${newTextValue}`);
            }
          });
          text.inputEl.addClass('leader-hotkeys-key');
        })
        .addDropdown((dropdown) => {
          this.commands.forEach((command) => {
            dropdown.addOption(command.id, command.name);
          });
          dropdown.setValue(commandName).onChange((newValue) => {
            console.log(`updating command for ${key} to ${newValue}`);
          });
          dropdown.selectEl.addClass('leader-hotkeys-command');
        });
    });

    containerEl.createEl('h3', { text: 'Create New Hotkey' });

    new Setting(containerEl)
      .addText((text) => {
        text.setPlaceholder('a').onChange((newTextValue) => {
          if (newTextValue === '') {
            return;
          }
          const isValid = this.validateNewHotkey(newTextValue);
          if (isValid) {
            console.log(`storing temp value for new hotkey ${newTextValue}`);
          }
        });
        text.inputEl.addClass('leader-hotkeys-key');
      })
      .addDropdown((dropdown) => {
        dropdown.addOption('invalid-placeholder', 'Select a Command');
        this.commands.forEach((command) => {
          dropdown.addOption(command.id, command.name);
        });
        dropdown.onChange((newValue) => {
          console.log(`storing temp value for new command ${newValue}`);
        });
        dropdown.selectEl.addClass('leader-hotkeys-command');
      });

    new Setting(containerEl).addButton((button) => {
      button.setButtonText('Save New Hotkey').onClick(() => {
        console.log('should store new hotkey');
      });
    });
  }
}
