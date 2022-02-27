import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';

interface Command {
  name: string;
  id: string;
}

class Hotkey {
  public key: string;
  public meta: boolean;
  public shift: boolean;
  public commandID: string;
}

interface Settings {
  hotkeys: Hotkey[];
}

const defaultHotkeys: Hotkey[] = [
  { key: 'h', meta: false, shift: false, commandID: 'editor:focus-left' },
  { key: 'j', meta: false, shift: false, commandID: 'editor:focus-bottom' },
  { key: 'k', meta: false, shift: false, commandID: 'editor:focus-top' },
  { key: 'l', meta: false, shift: false, commandID: 'editor:focus-right' },
];

const defaultSettings: Settings = {
  hotkeys: defaultHotkeys,
};

export default class LeaderHotkeysPlugin extends Plugin {
  public settings: Settings;

  private leaderPending: boolean;
  private cmEditors: CodeMirror.Editor[];

  public async onload(): Promise<void> {
    const savedSettings = await this.loadData();
    this.settings = savedSettings || defaultSettings;

    this.cmEditors = [];
    this.registerEvent(
      this.app.workspace.on('codemirror', (cm: CodeMirror.Editor) => {
        this.cmEditors.push(cm);
        cm.on('keydown', this.handleKeyDown);
      }),
    );

    this.addCommand({
      id: 'leader',
      name: 'Leader key',
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

    if (event.key === 'Shift' || event.key === 'Meta') {
      // Don't clear leaderPending for a meta key
      console.debug('skipping a meta key');
      return;
    }

    let commandFound = false;
    for (let i = 0; i < this.settings.hotkeys.length; i++) {
      const evaluatingHotkey = this.settings.hotkeys[i];
      if (evaluatingHotkey.key === event.key) {
        if (
          // check true and false to catch commands with meta/shift undefined
          ((event.metaKey && evaluatingHotkey.meta) ||
            (!event.metaKey && !evaluatingHotkey.meta)) &&
          ((event.shiftKey && evaluatingHotkey.shift) ||
            (!event.shiftKey && !evaluatingHotkey.shift))
        ) {
          (this.app as any).commands.executeCommandById(
            this.settings.hotkeys[i].commandID,
          );
          event.preventDefault();
          commandFound = true;
          break;
        }
      }
    }

    if (!commandFound) {
      console.debug('cancelling leader');
    }

    this.leaderPending = false;
  };
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
