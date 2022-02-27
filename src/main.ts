import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, } from 'obsidian';


// region Obsidian Type Shim
interface ObsidianCommand {
	callback: () => void
	icon: string
	id: string
	name: string
}

interface CommandMap {
	[ key: string ]: ObsidianCommand
}

interface ObsidianApp {
	// todo
	appId: string
	account
	commands
	customCss
	dom
	dragManager
	fileManager
	foldManager
	hotkeyManager
	internalPlugins
	isMobile
	keymap
	lastEvent
	loadProgress
	metadataCache
	mobileToolbar
	nextFrameEvents
	nextFrameTimer
	plugins
	scope
	setting
	shareReceiver
	statusBar
	vault
	viewRegistry
	workspace
}

interface CustomCommand {
	key: string
	modifiers: string[]
}


// endregion

// region General Type Shim
type Optional<T> = T | undefined | null;
interface Hashable {
	serialize(): string;
}
interface StateMachine<K, T> {
	// Would love to restrict T to a finite set ( T extends Enum),
	// but it's not possible to do that in TypeScript
	advance: ( event: K ) => T
}
// endregion

// region Trie
interface HashIter extends Iterable<Hashable> {
}

class TrieNode<T> {
	public children = new Map<string, TrieNode<T>>();

	public value: Optional<T>;

	public child( key: string ): Optional<TrieNode<T>> {
		return this.children.get( key );
	}

	public addChild( key: string, child: TrieNode<T> ): void {
		this.value = null;
		this.children.set( key, child );
	}

	public leaves(): TrieNode<T>[] {

		if ( this.isLeaf() ) {
			return [ this ];
		}


		let result: TrieNode<T>[] = [];

		this.children.forEach( ( child, key ) => {
			result = result.concat( child.leaves() );
		} );

		return result;
	}

	public leafValues(): T[] {
		return this.leaves().map( ( node ) => node.value );
	}

	public isLeaf(): boolean {
		return this.children.size === 0;
	}

	public setValue( value: T ): void {
		this.value = value;
	}
}

class Trie<T extends HashIter> {
	private readonly root: TrieNode<T>;

	constructor( keymaps: T[] ) {
		this.root = new TrieNode();

		for ( const keymap of keymaps ) {
			this.add( keymap )
		}

	}

	public add( composite: T ): void {
		let lastSeenNode = this.root;
		for ( const component of composite ) {
			const key   = component.serialize();
			const child = lastSeenNode.child( key ) || new TrieNode();
			lastSeenNode.addChild( key, child );
			lastSeenNode = child;
		}
		if ( lastSeenNode.value !== undefined ) {
			throw new Error( 'Duplicate keymap' );
		}
		lastSeenNode.setValue( composite );
	}

	public bestMatch( sequence: Hashable[] ): Optional<TrieNode<T>> {
		let lastNode = this.root;
		for ( const keyPress of sequence ) {
			const key   = keyPress.serialize();
			const child = lastNode.child( key );
			if ( !child ) {
				return null;
			}
			lastNode = child;
		}

		return lastNode;
	}

	public contains( sequence: Hashable[] ): boolean {
		return this.bestMatch( sequence ) !== null;
	}

}
// endregion

// region Fundamental Domain

class KeyPress implements Hashable {

	// region static constructors
	public static ctrl( key: string ): KeyPress {
		return new KeyPress( key, false, false, true, false );
	}

	public static alt( key: string ): KeyPress {
		return new KeyPress( key, false, true, false, false );
	}

	public static shift( key: string ): KeyPress {
		return new KeyPress( key, true, false, false, false );
	}

	public static meta( key: string ): KeyPress {
		return new KeyPress( key, false, false, false, true );
	}

	public static just( key: string ): KeyPress {
		return new KeyPress( key, false, false, false, false );
	}

	public static ctrlAlt( key: string ): KeyPress {
		return new KeyPress( key, false, true, true, false );
	}

	public static fromEvent( event: KeyboardEvent ): KeyPress {
		const key   = event.key;
		const shift = event.shiftKey;
		const ctrl  = event.ctrlKey;
		const alt   = event.altKey;
		const meta  = event.metaKey
		return new KeyPress( key, shift, alt, ctrl, meta );
	}

	public static fromCustom( binding: CustomCommand ): KeyPress {
		const key   = binding.key
		const shift = binding.modifiers.contains( 'Shift' );
		const ctrl  = binding.modifiers.contains( 'Ctrl' );
		const alt   = binding.modifiers.contains( 'Alt' );
		const meta  = binding.modifiers.contains( 'Meta' );
		return new KeyPress( key, shift, ctrl, alt, meta );
	}

	// endregion

	public readonly key: string;
	public readonly alt: boolean;
	public readonly ctrl: boolean;
	public readonly shift: boolean;
	public readonly meta: boolean;

	public constructor( key: string, shift: boolean, alt: boolean, ctrl: boolean, meta: boolean ) {
		this.key   = key;
		this.shift = shift;
		this.alt   = alt
		this.ctrl  = ctrl
		this.meta  = meta;
	}

	public repr(): string {
		const metaRepr  = this.meta ? '⌘ + ' : '';
		const altRepr   = this.alt ? 'Alt + ' : '';
		const ctrlRepr  = this.ctrl ? 'Ctrl + ' : '';
		const shiftRepr = this.shift ? '⇧ + ' : '';

		return metaRepr + ctrlRepr + altRepr + shiftRepr + this.key
	}

	public serialize(): string {
		// todo possibly use another representation
		return this.repr();
	}

	public containsKey(): boolean {
		return (
			this.key !== null &&
			this.key !== undefined &&
			this.key !== 'Alt' &&
			this.key !== 'Control' &&
			this.key !== 'Shift' &&
			this.key !== 'Meta'
		);
	}

}

class KeyMap implements Iterable<KeyPress> {

	public sequence: KeyPress[];
	public commandID: string;

	constructor( commandID: string, sequence: KeyPress[] ) {
		this.sequence  = sequence;
		this.commandID = commandID;
	}

	public [ Symbol.iterator ](): Iterator<KeyPress> {
		return this.sequence.values();
	}


}

interface SavedSettings {
	hotkeys: KeyMap[];
}

// endregion

// region Workspace Keymap Matching

enum KeyMatchingState {
	NoMatch,
	StartedMatch,
	RetainedMatch,
	ImprovedMatch,
	SuccessMatch,
	InvalidMatch,
}

class KeyMatcher implements StateMachine<KeyPress, KeyMatchingState> {
	private readonly trie: Trie<KeyMap>;
	private currentState: KeyMatchingState;
	private currentSequence: KeyPress[];
	private currentMatches: KeyMap[];

	constructor( trie : Trie< KeyMap> ) {
		this.trie = trie;
		this.currentState    = KeyMatchingState.NoMatch;
		this.currentSequence = [];
		this.currentMatches  = [];
	}

	public advance( keypress: KeyPress ): KeyMatchingState {
		this.currentSequence.push( keypress );

		switch ( this.currentState ) {
			// Start Matching
			case KeyMatchingState.NoMatch: {
				const bestMatch     = this.trie.bestMatch( this.currentSequence );
				this.currentMatches = bestMatch ? bestMatch.leafValues() : [];
				// No Match Logic
				if ( !bestMatch ) {
					this.reset();
					this.currentState = KeyMatchingState.NoMatch;
				} else if ( bestMatch.isLeaf() ) {
					this.currentState = KeyMatchingState.SuccessMatch;
				} else {
					this.currentState = KeyMatchingState.StartedMatch;
				}
			}
				return this.currentState;
			// Continue / Finish Matching
			case KeyMatchingState.StartedMatch:
			case KeyMatchingState.RetainedMatch:
			case KeyMatchingState.ImprovedMatch:
				if ( !keypress.containsKey() ) {
					this.currentSequence.pop();
					this.currentState = KeyMatchingState.RetainedMatch;
					return this.currentState;
				}
			{
				const bestMatch     = this.trie.bestMatch( this.currentSequence );
				this.currentMatches = bestMatch ? bestMatch.leafValues() : [];

				if ( !bestMatch ) {
					this.currentState = KeyMatchingState.InvalidMatch;
				} else if ( bestMatch.isLeaf() ) {
					this.currentState = KeyMatchingState.SuccessMatch;
				} else {
					this.currentState = KeyMatchingState.ImprovedMatch;
				}
			}
				return this.currentState;
			// Clear previous matching and rematch
			case KeyMatchingState.SuccessMatch:
			case KeyMatchingState.InvalidMatch:
				this.reset();
				return this.advance( keypress );
		}
	}

	public allMatches(): readonly KeyMap[] {
		return this.currentMatches;
	}

	public fullMatch(): Optional<KeyMap> {
		const numMatches  = this.allMatches().length;
		const isFullMatch = this.currentState === KeyMatchingState.SuccessMatch;

		// Sanity checking.
		if ( isFullMatch && numMatches !== 1 ) {
			writeConsole(
				'State Machine in FullMatch state, but availableHotkeys.length contains more than 1 element. This is definitely a bug.',
			);
			return null;
		}

		if ( isFullMatch && numMatches === 1 ) {
			return this.currentMatches[ 0 ];
		}
		return null;
	}

	private reset(): void {
		this.currentState    = KeyMatchingState.NoMatch;
		this.currentSequence = [];
		this.currentMatches  = [];
	}
}

// endregion



export default class LeaderHotkeysPlugin extends Plugin {
	public settings: SavedSettings;
	private trie: Trie< KeyMap>
	private matcher: KeyMatcher;

	public async onload(): Promise<void> {
		writeConsole( 'Started Loading.' );

		await this._loadKeymaps();
		await this._registerWorkspaceEvents();
		await this._registerLeaderKeymap();
		await this._registerPeripheralUIElements();

		writeConsole( 'Finished Loading.' );
	}

	public onunload(): void {
		writeConsole( 'Unloading plugin.' );
	}

	private readonly handleKeyDown = ( event: KeyboardEvent ): void => {

		const keypress = KeyPress.fromEvent( event );

		const currentState = this.matcher.advance( keypress );
		switch ( currentState ) {
			case KeyMatchingState.NoMatch:
				writeConsole(
					'An keypress resulted in a NoMatch state. Letting this event pass.',
				);
				return;

			case KeyMatchingState.InvalidMatch:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a ExitMatch. Exiting matching state.',
				);
				return;

			case KeyMatchingState.StartedMatch:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a LeaderMatch. Entering matching state.',
				);
				return;

			case KeyMatchingState.RetainedMatch:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a RetainedMatch. Retaining matching state.',
				);
				return;

			case KeyMatchingState.ImprovedMatch:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a ImprovedMatch. Waiting for the rest of the key sequence.',
				);
				return;

			case KeyMatchingState.SuccessMatch:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a FullMatch. Dispatching keymap.',
				);

				const keymap = this.matcher.fullMatch();
				this.invoke( keymap )
				return;
		}
	};

	private async _loadKeymaps(): Promise<void> {
		writeConsole( 'Loading previously saved settings.' );

		const savedSettings = await this.loadData();

		if ( savedSettings ) {
			writeConsole( 'Successfully loaded previous settings.' );
		} else {
			writeConsole(
				'No saved settings were found, default ones will be used instead.',
			);
		}

		this.settings = savedSettings || defaultSettings;
		this.trie            = new Trie( this.settings.hotkeys );
		this.matcher  = new KeyMatcher( this.trie );
	}

	private async _registerWorkspaceEvents(): Promise<void> {
		writeConsole( 'Registering necessary event callbacks' );

		const workspaceContainer = this.app.workspace.containerEl;
		this.registerDomEvent( workspaceContainer, 'keydown', this.handleKeyDown );
		writeConsole( 'Registered workspace "keydown" event callbacks.' );
	}

	private async _registerLeaderKeymap(): Promise<void> {
		writeConsole( 'Registering leaderKey command.' );
		const leaderKeyCommand = {
			id:       'leader',
			name:     'Leader key',
			callback: () => {
				//	need something here.
			},
		};
		this.addCommand( leaderKeyCommand );
	}

	private async _registerPeripheralUIElements(): Promise<void> {
		writeConsole( 'Registering peripheral interface elements.' );

		const leaderPluginSettingsTab = new LeaderPluginSettingsTab( this.app, this );
		this.addSettingTab( leaderPluginSettingsTab );
		writeConsole( 'Registered Setting Tab.' );
	}

	private invoke( keymap: Optional<KeyMap> ): void {
		if ( keymap ) {
			const app = this.app as any;
			app.commands.executeCommandById( keymap.commandID );
		} else {
			writeConsole(
				'No keymap found for the full match. This is definitely a bug.',
			);
		}
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
		setNewKey: ( newKey: string, meta: boolean, shift: boolean ) => void,
	) {
		super( app );
		this.currentLeader = currentLeader;
		this.redraw        = redraw;
		this.setNewKey     = setNewKey;
	}

	public onOpen = (): void => {

		const introText = document.createElement( 'p' );
		introText.setText(
			`Press a key to use as the hotkey after the leader (${ this.currentLeader }) is pressed...`,
		);

		this.contentEl.appendChild( introText );

		document.addEventListener( 'keydown', this.handleKeyDown );
	};

	public onClose = (): void => {
		document.removeEventListener( 'keydown', this.handleKeyDown );
		this.redraw();
		this.contentEl.empty();
	};

	private readonly handleKeyDown = ( event: KeyboardEvent ): void => {
		const keyPress = KeyPress.fromEvent( event )

		if ( [ 'Shift', 'Meta', 'Escape' ].contains( event.key ) ) {
			return;
		}

		this.setNewKey( event.key, event.metaKey, event.shiftKey );
		this.close();
	};
}

class LeaderPluginSettingsTab extends PluginSettingTab {

	private static readonly listCommands = ( app: App, query?: string ): ObsidianCommand[] => {

		const anyApp               = app as any
		const commands: CommandMap = anyApp.commands.commands;
		let result                 = Object.values( commands )

		if ( query ) {
			result = result.filter( command => command.name.toLowerCase().includes( query.toLowerCase() ) )
		}

		return result
	}
	private static readonly lookupLeader = ( app: App ): Optional<KeyPress> => {

		console.log( app );
		const customKeys = ( app as any ).hotkeyManager.customKeys;
		const result     = customKeys[ 'leader-hotkeys-obsidian:leader' ]

		return result ? KeyPress.fromCustom( result[ 0 ] )
					  : null

	};
	private readonly plugin: LeaderHotkeysPlugin;
	private commands: ObsidianCommand[];

	private tempNewHotkey: KeyMap;

	constructor( app: App, plugin: LeaderHotkeysPlugin ) {
		super( app, plugin );
		this.plugin = plugin;
	}

	public display(): void {

		this.commands       = LeaderPluginSettingsTab.listCommands( this.app );
		const currentLeader = LeaderPluginSettingsTab.lookupLeader( this.app );
		const binding       = currentLeader ? `bound to ${ currentLeader.repr() }`
											: 'unbound'

		const containerEl = this.containerEl;
		containerEl.empty();


		{
			// Instructions
			containerEl.createEl( 'h2', { text: 'Leader Hotkeys Plugin - Settings' } );

			containerEl.createEl( 'p', {
				text:
					`The leader-hotkeys listed below are used by pressing a custom hotkey (called the leader), 
				then releasing and pressing the key defined for a particular command. 
				The leader hotkey can be configured in the Hotkeys settings page, 
				and is currently ${ binding }.`,
			} );
		}
		{
			// Existing hokeys
			containerEl.createEl( 'h3', { text: 'Existing Hotkeys' } );

			this.plugin.settings.hotkeys.forEach( ( configuredCommand ) => {
				const setting = new Setting( containerEl )
					.addDropdown( ( dropdown ) => {
						this.commands.forEach( ( command ) => {
							dropdown.addOption( command.id, command.name );
						} );
						dropdown
							.setValue( configuredCommand.commandID )
							.onChange( ( newCommand ) => {
								this.updateHotkeyCommandInSettings( configuredCommand, newCommand );
							} );
						dropdown.selectEl.addClass( 'leader-hotkeys-command' );
					} )
					.addExtraButton( ( button ) => {
						button
							.setIcon( 'cross' )
							.setTooltip( 'Delete shortcut' )
							.onClick( () => {
								this.deleteHotkeyFromSettings( configuredCommand );
								this.display();
							} );
						button.extraSettingsEl.addClass( 'leader-hotkeys-delete' );
					} );

				setting.infoEl.remove();
				const settingControl = setting.settingEl.children[ 0 ];

				const prependText = document.createElement( 'span' );
				prependText.addClass( 'leader-hotkeys-setting-prepend-text' );
				prependText.setText( `Use ${ currentLeader } followed by` );
				settingControl.insertBefore( prependText, settingControl.children[ 0 ] );

				const keySetter = document.createElement( 'kbd' );
				keySetter.addClass( 'setting-hotkey' );
				keySetter.setText( hotkeyToName( configuredCommand ) );
				keySetter.addEventListener( 'click', ( e: Event ) => {
					new SetHotkeyModal(
						this.app,
						currentLeader.repr(),
						() => {
							this.display();
						},
						( newKey: string, meta: boolean, shift: boolean ) => {
							const isValid = this.validateNewHotkey( newKey, meta, shift );
							if ( isValid ) {
								this.updateHotkeyInSettings(
									configuredCommand,
									newKey,
									meta,
									shift,
								);
							}
						},
					).open();
				} );
				settingControl.insertBefore( keySetter, settingControl.children[ 1 ] );

				const appendText = document.createElement( 'span' );
				appendText.addClass( 'leader-hotkeys-setting-append-text' );
				appendText.setText( 'to' );
				settingControl.insertBefore( appendText, settingControl.children[ 2 ] );
			} );

		}
		{
			containerEl.createEl( 'h3', { text: 'Create New Hotkey' } );

			const newHotkeySetting = new Setting( containerEl ).addDropdown(
				( dropdown ) => {
					dropdown.addOption( 'invalid-placeholder', 'Select a Command' );
					this.commands.forEach( ( command ) => {
						dropdown.addOption( command.id, command.name );
					} );
					dropdown.onChange( ( newCommand ) => {
						if ( this.tempNewHotkey === undefined ) {
							this.tempNewHotkey = newEmptyHotkey();
						}
						this.tempNewHotkey.commandID = newCommand;
					} );
					dropdown.selectEl.addClass( 'leader-hotkeys-command' );
				},
			);

			newHotkeySetting.infoEl.remove();
			const settingControl = newHotkeySetting.settingEl.children[ 0 ];

			const prependText = document.createElement( 'span' );
			prependText.addClass( 'leader-hotkeys-setting-prepend-text' );
			prependText.setText( `Use ${ currentLeader } followed by` );
			settingControl.insertBefore( prependText, settingControl.children[ 0 ] );

			const keySetter = document.createElement( 'kbd' );
			keySetter.addClass( 'setting-hotkey' );
			keySetter.setText( hotkeyToName( this.tempNewHotkey ) );
			keySetter.addEventListener( 'click', ( e: Event ) => {
				new SetHotkeyModal(
					this.app,
					currentLeader.repr(),
					() => {
						this.display();
					},
					( newKey: string, meta: boolean, shift: boolean ) => {
						if ( this.tempNewHotkey === undefined ) {
							this.tempNewHotkey = newEmptyHotkey();
						}
						this.tempNewHotkey.key   = newKey;
						this.tempNewHotkey.meta  = meta;
						this.tempNewHotkey.shift = shift;
					},
				).open();
			} );
			settingControl.insertBefore( keySetter, settingControl.children[ 1 ] );

			const appendText = document.createElement( 'span' );
			appendText.addClass( 'leader-hotkeys-setting-append-text' );
			appendText.setText( 'to' );
			settingControl.insertBefore( appendText, settingControl.children[ 2 ] );

			new Setting( containerEl ).addButton( ( button ) => {
				button.setButtonText( 'Save New Hotkey' ).onClick( () => {
					const isValid = this.validateNewHotkey(
						this.tempNewHotkey.key,
						this.tempNewHotkey.meta,
						this.tempNewHotkey.shift,
					);
					if ( isValid ) {
						this.storeNewHotkeyInSettings();
						this.display();
					}
				} );
			} );
		}
	}


	private readonly validateNewHotkey = (
		key: string,
		meta: boolean,
		shift: boolean,
	): boolean => {
		for ( let i = 0; i < this.plugin.settings.hotkeys.length; i++ ) {
			const hotkey = this.plugin.settings.hotkeys[ i ];
			if (
				hotkey.key === key &&
				hotkey.meta === meta &&
				hotkey.shift === shift
			) {
				const hotkeyName = hotkeyToName( hotkey );
				new Notice( `Leader hotkey '${ hotkeyName }' is already in use` );
				return false;
			}
		}

		return true;
	};

	private readonly deleteHotkeyFromSettings = (
		existingHotkey: KeyMap,
	): void => {
		for ( let i = 0; i < this.plugin.settings.hotkeys.length; i++ ) {
			const hotkey = this.plugin.settings.hotkeys[ i ];
			if (
				hotkey.key !== existingHotkey.key ||
				hotkey.meta !== existingHotkey.meta ||
				hotkey.shift !== existingHotkey.shift
			) {
				continue;
			}

			console.debug(
				`Removing leader-hotkey ${ hotkeyToName( existingHotkey ) } at index ${ i }`,
			);
			this.plugin.settings.hotkeys.splice( i, 1 );
		}
		this.plugin.saveData( this.plugin.settings );
	};

	private readonly updateHotkeyInSettings = (
		existingHotkey: KeyMap,
		newKey: string,
		meta: boolean,
		shift: boolean,
	): void => {
		for ( let i = 0; i < this.plugin.settings.hotkeys.length; i++ ) {
			const hotkey = this.plugin.settings.hotkeys[ i ];
			if (
				hotkey.key !== existingHotkey.key ||
				hotkey.meta !== existingHotkey.meta ||
				hotkey.shift !== existingHotkey.shift
			) {
				continue;
			}

			console.debug(
				`Updating leader-hotkey ${ hotkeyToName(
					existingHotkey,
				) } at index ${ i } to ${ newKey }`,
			);
			hotkey.key   = newKey;
			hotkey.meta  = meta;
			hotkey.shift = shift;
			break;
		}
		this.plugin.saveData( this.plugin.settings );
	};

	private readonly updateHotkeyCommandInSettings = (
		existingHotkey: KeyMap,
		newCommand: string,
	): void => {
		for ( let i = 0; i < this.plugin.settings.hotkeys.length; i++ ) {
			const hotkey = this.plugin.settings.hotkeys[ i ];
			if (
				hotkey.key !== existingHotkey.key ||
				hotkey.meta !== existingHotkey.meta ||
				hotkey.shift !== existingHotkey.shift
			) {
				continue;
			}

			console.debug(
				`Updating leader-hotkey command ${ hotkeyToName(
					existingHotkey,
				) } at index ${ i } to ${ newCommand }`,
			);
			hotkey.commandID = newCommand;
			break;
		}
		this.plugin.saveData( this.plugin.settings );
	};

	private readonly storeNewHotkeyInSettings = (): void => {
		console.debug(
			`Adding leader-hotkey command ${ this.tempNewHotkey } to ${ this.tempNewHotkey.commandID }`,
		);
		this.plugin.settings.hotkeys.push( this.tempNewHotkey );
		this.plugin.saveData( this.plugin.settings );
		this.tempNewHotkey = newEmptyHotkey();
	};


}

const defaultHotkeys: KeyMap[]       = [
	new KeyMap( 'editor:focus-left',
				[ KeyPress.ctrl( 'b' ), KeyPress.just( 'h' )
				] ),
	new KeyMap( 'editor:focus-right', [
		KeyPress.ctrl( 'b' ), KeyPress.just( 'l' ),
	] ),
	new KeyMap( 'editor:focus-top', [
		KeyPress.ctrl( 'b' ), KeyPress.just( 'k' )
	] ),
	new KeyMap( 'editor:focus-bottom', [
		KeyPress.ctrl( 'b' ), KeyPress.just( 'j' )
	] ),
	new KeyMap( 'command-palette:open', [
		KeyPress.ctrl( 'q' ),
		KeyPress.just( '1' ),
		KeyPress.just( '2' ),
		KeyPress.just( '2' )
	] ),
	new KeyMap( 'command-palette:open', [
		KeyPress.ctrl( ' ' ),
		KeyPress.just( 'p' ),
		KeyPress.just( 'a' ),
		KeyPress.just( 'l' ),
		KeyPress.just( 'l' ),
		KeyPress.just( 'e' ),
		KeyPress.just( 't' ),
		KeyPress.just( 't' ),
		KeyPress.just( 'e' ),
	] ),
];
const defaultSettings: SavedSettings = {
	hotkeys: defaultHotkeys,
};

const writeConsole   = ( message: string ): void => {
	console.debug( ` Leader Hotkeys: ${ message }` );
};
const newEmptyHotkey = (): KeyMap => ( {
	key:       '',
	shift:     false,
	meta:      false,
	commandID: '',
} );
const hotkeyToName   = ( hotkey: KeyMap ): string => {
	if ( hotkey === undefined || hotkey.key === '' ) {
		return '?';
	}
	const keyToUse = ( () => {
		switch ( hotkey.key ) {
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
	} )();
	return (
		( hotkey.meta ? 'meta+' : '' ) + ( hotkey.shift ? 'shift+' : '' ) + keyToUse
	);
};
