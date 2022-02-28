import { App, Modal, Plugin, PluginSettingTab, Setting, } from 'obsidian';

// region  Type Shims
interface ObsidianCommand {
	callback: () => void;
	icon: string;
	id: string;
	name: string;
}

interface CommandMap {
	[ key: string ]: ObsidianCommand;
}

interface ObsidianApp {
	// todo
	appId: string;
	account;
	commands;
	customCss;
	dom;
	dragManager;
	fileManager;
	foldManager;
	hotkeyManager;
	internalPlugins;
	isMobile;
	keymap;
	lastEvent;
	loadProgress;
	metadataCache;
	mobileToolbar;
	nextFrameEvents;
	nextFrameTimer;
	plugins;
	scope;
	setting;
	shareReceiver;
	statusBar;
	vault;
	viewRegistry;
	workspace;
}

interface CustomCommand {
	key: string;
	modifiers: string[];
}

//
type Optional<T> = T | undefined | null;

interface Hashable {
	serialize(): string;
}

interface StateMachine<K, T> {
	// Would love to restrict T to a finite set ( T extends Enum),
	// but it's not possible to do that in TypeScript
	advance: ( event: K ) => T;
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

	constructor() {
		this.root = new TrieNode();
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
enum PressType {
	NoKey,
	SpecialKey,
	NormalKey,
}

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
		const meta  = event.metaKey;
		return new KeyPress( key, shift, alt, ctrl, meta );
	}

	public static fromCustom( binding: CustomCommand ): KeyPress {
		const key   = binding.key;
		const shift = binding.modifiers.contains( 'Shift' );
		const ctrl  = binding.modifiers.contains( 'Ctrl' );
		const alt   = binding.modifiers.contains( 'Alt' );
		const meta  = binding.modifiers.contains( 'Meta' );
		return new KeyPress( key, shift, ctrl, alt, meta );
	}

	public static of( keyPressLike: KeyPress ): KeyPress {
		return new KeyPress(
			keyPressLike.key,
			keyPressLike.shift,
			keyPressLike.alt,
			keyPressLike.ctrl,
			keyPressLike.meta,
		);
	}

	// endregion

	public readonly key: string;
	public readonly alt: boolean;
	public readonly ctrl: boolean;
	public readonly shift: boolean;
	public readonly meta: boolean;

	public constructor(
		key: string,
		shift: boolean,
		alt: boolean,
		ctrl: boolean,
		meta: boolean,
	) {
		this.key   = key;
		this.shift = shift;
		this.alt   = alt;
		this.ctrl  = ctrl;
		this.meta  = meta;
	}

	public readonly repr = (): string => {
		const metaRepr  = this.meta ? '⌘ + ' : '';
		const altRepr   = this.alt ? 'Alt + ' : '';
		const ctrlRepr  = this.ctrl ? 'Ctrl + ' : '';
		const shiftRepr = this.shift ? '⇧ + ' : '';

		return metaRepr + ctrlRepr + altRepr + shiftRepr + this.key;
	};

	public readonly serialize = (): string => {
		return this.repr()
	};

	public readonly containsKey = (): boolean => {
		return ( this.key !== null &&
				 this.key !== undefined &&
				 this.key !== 'Alt' &&
				 this.key !== 'Control' &&
				 this.key !== 'Shift' &&
				 this.key !== 'Meta'
		);
	};

	public readonly classification = (): PressType => {
		if (
			this.key === null ||
			this.key === undefined ||
			this.key === 'Alt' ||
			this.key === 'Control' ||
			this.key === 'Shift' ||
			this.key === 'Meta'
		) {
			return PressType.NoKey;
		}

		if ( this.key === 'Enter' || this.key === 'Escape' ) {
			return PressType.SpecialKey;
		}

		return PressType.NormalKey;
	};
}

class KeyMap implements Iterable<KeyPress> {
	public static of( keyMapLike: KeyMap ): KeyMap {
		const presses = keyMapLike.sequence.map( KeyPress.of );
		const command = keyMapLike.commandID;
		return new KeyMap( command, presses );
	}

	public sequence: KeyPress[];
	public commandID: string;

	constructor( commandID: string, sequence: KeyPress[] ) {
		this.sequence  = sequence;
		this.commandID = commandID;
	}

	public [ Symbol.iterator ](): Iterator<KeyPress> {
		return this.sequence.values();
	}

	public repr = (): string => {
		return (
			this.commandID +
			' = ' +
			this.sequence.map( ( key ) => key.repr() ).join( ' => ' )
		);
	};
}

interface SavedSettings {
	hotkeys: KeyMap[];
}

// endregion

// region Matching of existing keymaps

enum MatchType {
	NoMatch,
	PartialMatch,
	FullMatch,
}

enum MatchMachineState {
	NoMatch,
	StartedMatch,
	RetainedMatch,
	ImprovedMatch,
	SuccessMatch,
	InvalidMatch,
}

class MatchMachine implements StateMachine<KeyPress, MatchMachineState> {
	private static classify( bestMatch: Optional<TrieNode<KeyMap>> ): MatchType {
		if ( !bestMatch ) {
			return MatchType.NoMatch;
		}
		if ( bestMatch.isLeaf() ) {
			return MatchType.FullMatch;
		}
		return MatchType.PartialMatch;
	}

	private readonly trie: Trie<KeyMap>;
	private currentState: MatchMachineState;
	private currentSequence: KeyPress[];
	private currentMatches: KeyMap[];

	constructor( trie: Trie<KeyMap> ) {
		this.trie            = trie;
		this.currentState    = MatchMachineState.NoMatch;
		this.currentSequence = [];
		this.currentMatches  = [];
	}

	public advance = ( keypress: KeyPress ): MatchMachineState => {
		this.currentSequence.push( keypress );

		const bestMatch = this.trie.bestMatch( this.currentSequence );
		const matchType = MatchMachine.classify( bestMatch );

		this.currentMatches = bestMatch ? bestMatch.leafValues() : [];

		switch ( this.currentState ) {
			// Start Matching
			case MatchMachineState.NoMatch:
				if ( matchType === MatchType.NoMatch ) {
					this.currentSequence.pop();
					this.currentState = MatchMachineState.NoMatch;
				} else if ( matchType === MatchType.FullMatch ) {
					// Suspicious to have a full match here.
					this.currentState = MatchMachineState.SuccessMatch;
				} else {
					this.currentState = MatchMachineState.StartedMatch;
				}
				return this.currentState;
			// Continue / Finish Matching
			case MatchMachineState.StartedMatch:
			case MatchMachineState.RetainedMatch:
			case MatchMachineState.ImprovedMatch:
				if ( keypress.classification() === PressType.NoKey ) {
					this.currentSequence.pop();
					this.currentState = MatchMachineState.RetainedMatch;
				} else if ( matchType === MatchType.NoMatch ) {
					this.currentState = MatchMachineState.InvalidMatch;
				} else if ( matchType === MatchType.FullMatch ) {
					this.currentState = MatchMachineState.SuccessMatch;
				} else {
					this.currentState = MatchMachineState.ImprovedMatch;
				}
				return this.currentState;
			// Clear previous matching and rematch
			case MatchMachineState.SuccessMatch:
			case MatchMachineState.InvalidMatch:
				this.currentState    = MatchMachineState.NoMatch;
				this.currentSequence = [];
				this.currentMatches  = [];
				return this.advance( keypress );
		}
	};

	public allMatches = (): readonly KeyMap[] => {
		return this.currentMatches;
	};

	public fullMatch = (): Optional<KeyMap> => {
		const numMatches  = this.allMatches().length;
		const isFullMatch = this.currentState === MatchMachineState.SuccessMatch;

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
	};
}

// endregion

// region Registering of new keymaps

enum RegisterMachineState {
	NoKeys,
	FirstKey,
	AddedKeys,
	RetainedKeys,
	BacktrackedKey,
	PendingConfirmation,
	FinishedRegistering,
}

class RegisterMachine implements StateMachine<KeyPress, RegisterMachineState> {
	private currentState: RegisterMachineState;
	private currentSequence: KeyPress[];

	constructor() {
		this.currentState    = RegisterMachineState.NoKeys;
		this.currentSequence = [];
	}

	public readonly advance = ( event: KeyPress ): RegisterMachineState => {

		const classification = event.classification();

		switch ( this.currentState ) {
			case RegisterMachineState.NoKeys:
				if ( classification === PressType.NoKey ) {
					this.currentState = RegisterMachineState.RetainedKeys;
				} else if ( classification === PressType.SpecialKey ) {
					this.currentSequence.push(event)
					this.currentState = RegisterMachineState.PendingConfirmation;
				} else {
					this.currentSequence.push(event)
					this.currentState = RegisterMachineState.FirstKey;
				}
				return this.currentState;

			case RegisterMachineState.FirstKey:
			case RegisterMachineState.RetainedKeys:
			case RegisterMachineState.BacktrackedKey:
			case RegisterMachineState.AddedKeys:
				if ( classification === PressType.NoKey ) {
					this.currentState = RegisterMachineState.RetainedKeys;
				} else if ( classification === PressType.SpecialKey ) {
					this.currentSequence.push(event)
					this.currentState = RegisterMachineState.PendingConfirmation;
				} else {
					this.currentSequence.push(event)
					this.currentState = RegisterMachineState.AddedKeys;
				}
				return this.currentState;

			case RegisterMachineState.PendingConfirmation:
				if ( event.key === 'Enter' && event.ctrl && event.alt ) {
					this.currentState = RegisterMachineState.FinishedRegistering;
				} else if ( event.key === 'Enter' ) {
					this.currentState = RegisterMachineState.AddedKeys;
				} else if ( event.key === 'Backspace' ) {
					this.currentSequence.pop();
					this.currentState = RegisterMachineState.BacktrackedKey;
				} else {
					this.currentState = RegisterMachineState.PendingConfirmation;
				}
				return this.currentState;

			case RegisterMachineState.FinishedRegistering: {
				this.reset();
				return this.advance( event );
			}
		}
	};

	public readonly presses = (): readonly KeyPress[] => {
		return this.currentSequence;
	};

	public readonly representation = (): string => {
		return this.presses()
			.map( ( key ) => key.repr() )
			.join( ' => ' );
	};

	private readonly reset = (): void => {
		this.currentState    = RegisterMachineState.NoKeys;
		this.currentSequence = [];
	};
}

class KeymapRegisterer extends Modal {
	private readonly registerMachine: RegisterMachine;
	private readonly customParent: LeaderSettingsTab;

	constructor( parent: LeaderSettingsTab ) {
		super( parent.app );
		this.customParent    = parent;
		this.registerMachine = new RegisterMachine();
	}

	public readonly onOpen = (): void => {
		const introText = document.createElement( 'p' );
		introText.setText( 'Just Testing, you know' );
		this.contentEl.appendChild( introText );

		document.addEventListener( 'keydown', this.handleKeyDown );
	};

	public readonly onClose = (): void => {
		document.removeEventListener( 'keydown', this.handleKeyDown );
		this.redraw();
		this.contentEl.empty();
	};

	private readonly redraw = (): void => {
		this.customParent.display();
	};

	private readonly saveKeyMap = ( keymap: KeyMap ): void => {
		this.customParent.updateKeymap( null, null, null, null );
	};

	private readonly handleKeyDown = ( event: KeyboardEvent ): void => {
		console.log( event );
		console.log( this.registerMachine );
		const keyPress      = KeyPress.fromEvent( event );
		const registerState = this.registerMachine.advance( keyPress );

		switch ( registerState ) {
			case RegisterMachineState.NoKeys:
				writeConsole( 'An keypress resulted in a NoKeys state. ' );
				event.preventDefault();
				this.setText( 'Waiting for keypress' );
				return;

			case RegisterMachineState.RetainedKeys:
				writeConsole(
					'An keypress resulted in a RetainedKeys state. Awaiting further keypresses.',
				);
				event.preventDefault();
				return;

			case RegisterMachineState.FirstKey:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a FirstKey state. Awaiting further keypresses.',
				);
				this.setText( this.registerMachine.representation() );
				return;

			case RegisterMachineState.BacktrackedKey:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a BacktrackedKey state. Awaiting further keypresses.',
				);
				this.setText( this.registerMachine.representation() );
				return;

			case RegisterMachineState.AddedKeys:
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a AddedKeys state. Awaiting further keypresses.',
				);
				this.setText( this.registerMachine.representation() );
				return;

			case RegisterMachineState.PendingConfirmation:
				event.preventDefault();
			{
				writeConsole(
					'An keypress resulted in a PendingConfirmation state. Showing confirmation text.',
				);

				this.contentEl.empty();
				const introText = document.createElement( 'p' );
				introText.setText( this.registerMachine.representation() );
				this.contentEl.appendChild( introText );

				// todo: Prettify.
				const confirmText = document.createElement( 'p' );
				confirmText.setText(
					'Did you mean literal "lastKey"?. If so, Press Enter.' +
					'If not, discard it with Backspace. If you wanted to finish, press Ctrl + Alt + Enter',
				);
				this.contentEl.append( confirmText );
			}
				return;

			case RegisterMachineState.FinishedRegistering:
				event.preventDefault();
				writeConsole( 'An keypress resulted in a FinishedRegistering state.' );
				// const conflict = this.existingSettingsConflict( this.keyRegister.presses(), );
				// this.setText(
				//   'This sequence conflicts with other sequences [ . . . ] . Please try again.',
				// );
				// return;
				// if (!conflict) {
				//   return;
				// }
				//
				// this.setNewKey(this.keyRegister.representation(), false, false);
				this.close();
				return;
		}
	};

	private readonly setText = ( text: string ): void => {
		this.contentEl.empty();
		const introText = document.createElement( 'p' );
		introText.setText( text );
		this.contentEl.appendChild( introText );
	};

	private readonly existingSettingsConflict = (
		keyPresses: readonly KeyPress[],
	): KeyMap[] => {
		return [];
	};
}

// endregion

class LeaderSettingsTab extends PluginSettingTab {
	private static readonly listCommands = (
		app: App,
		query?: string,
	): ObsidianCommand[] => {
		const anyApp               = app as any;
		const commands: CommandMap = anyApp.commands.commands;
		let result                 = Object.values( commands );

		if ( query ) {
			result = result.filter( ( command ) =>
										command.name.toLowerCase().includes( query.toLowerCase() ),
			);
		}

		return result;
	};
	private static readonly lookupLeader = ( app: App ): Optional<KeyPress> => {
		const customKeys = ( app as any ).hotkeyManager.customKeys;
		const result     = customKeys[ 'leader-hotkeys-obsidian:leader' ];

		return result ? KeyPress.fromCustom( result[ 0 ] ) : null;
	};

	private readonly plugin: LeaderHotkeys;
	private commands: ObsidianCommand[];
	private tempNewHotkey: KeyMap;

	constructor( plugin: LeaderHotkeys ) {
		super( plugin.app, plugin );
		this.plugin = plugin;
		this.app    = plugin.app;
	}

	public display(): void {
		this.commands       = LeaderSettingsTab.listCommands( this.app );
		const currentLeader = LeaderSettingsTab.lookupLeader( this.app );
		const binding       = currentLeader
							  ? `bound to ${ currentLeader.repr() }`
							  : 'unbound';

		const containerEl = this.containerEl;
		containerEl.empty();

		{
			// Instructions
			containerEl.createEl( 'h2', { text: 'Leader Hotkeys Plugin - Settings' } );

			containerEl.createEl( 'p', {
				text: `The leader-hotkeys listed below are used by pressing a custom hotkey (called the leader), 
				then releasing and pressing the key defined for a particular command. 
				The leader hotkey can be configured in the Hotkeys settings page, 
				and is currently ${ binding }.`,
			} );
		}
		{
			// Existing hokeys
			containerEl.createEl( 'h3', { text: 'Existing Hotkeys' } );

			this.currentKeymaps().forEach( ( configuredCommand ) => {
				const setting = new Setting( containerEl )
					.addDropdown( ( dropdown ) => {
						this.commands.forEach( ( command ) => {
							dropdown.addOption( command.id, command.name );
						} );
						dropdown
							.setValue( configuredCommand.commandID )
							.onChange( ( newCommand ) => {
								this.updateHotkeyCommandInSettings(
									configuredCommand,
									newCommand,
								);
							} );
						dropdown.selectEl.addClass( 'leader-hotkeys-command' );
					} )
					.addExtraButton( ( button ) => {
						button
							.setIcon( 'cross' )
							.setTooltip( 'Delete shortcut' )
							.onClick( () => {
								this.removeKeymap( configuredCommand );
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
					const registerer = new KeymapRegisterer( this );
					console.log( registerer );
					registerer.open();
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
				const registerer = new KeymapRegisterer( this );
				console.log( registerer );
				registerer.open();
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

	public isConflicting( presses: KeyPress[] ): boolean {
		const keyMaps = this.matchKeymap( presses);
		return keyMaps ? true : false;
	}

	public matchKeymap( presses : KeyPress[]): KeyMap[] {

		const trie         = this.plugin.getTrie();
		const matches = trie.bestMatch( presses );
		return matches ? matches.leafValues() : [];
	}

	public addKeymap( keymap: KeyMap) : void {

		writeConsole( `Adding keymap: ${ keymap.repr() }`);

		const newHotkeys = [...this.currentKeymaps()].concat( keymap );

		this.saveKeymap( newHotkeys);
	}

	public removeKeymap( positionId: number): void {

		const currentHotkeys = this.currentKeymaps()
		const toRemove = currentHotkeys[ positionId ];
		writeConsole( `Removing keymap: ${ toRemove.repr() }`);


		const newKeymap = []
		for ( let i = 0; i < currentHotkeys.length; i++ ) {
			if ( i !== positionId ) {
				newKeymap.push( currentHotkeys[ i ] );
			}
		}

		this.saveKeymap( newKeymap );
	}

	public updateKeymap( positionId: number, keyMap: KeyMap ): void {

		writeConsole( `Updating keymap at position ${ positionId}: ${ keyMap.repr() }`);
		const keyMaps           = [...this.currentKeymaps()];
		keyMaps[ positionId ] = keyMap;
		this.saveKeymap(keyMaps)
	}

	private saveKeymap( keymaps : KeyMap[]) : void {
		const keyMapString = keymaps.map( ( keymap) => keymap.repr()).join( '\n');
		writeConsole( `Saving keymap: ${ keyMapString }`);

		this.plugin.settings.hotkeys = keymaps;
		this.plugin.saveData( this.plugin.settings )
			.then( ( ) => {
				//	todo: Notify.
			})
			.catch( err => {
				// todo: notify
			}) ;
	}

	private currentSettings(): SavedSettings {
		return this.plugin.settings;
	}
	private currentKeymaps() : KeyMap[] {
		return this.currentSettings().hotkeys;
	}

}

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

export default class LeaderHotkeys extends Plugin {
	public settings: SavedSettings;
	private trie: Trie<KeyMap>;
	private matcher: MatchMachine;

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

	public getTrie() : Trie< KeyMap> {
		return this.trie;
	}
	public setTrie( trie: Trie< KeyMap> ) : void {
		this.trie = trie;
		this.matcher = new MatchMachine( this.trie );
	}

	private readonly handleKeyDown = ( event: KeyboardEvent ): void => {
		console.log( event );
		const keypress = KeyPress.fromEvent( event );

		const currentState = this.matcher.advance( keypress );
		switch ( currentState ) {
			case MatchMachineState.NoMatch:
				writeConsole(
					'An keypress resulted in a NoMatch state. Letting this event pass.',
				);
				return;

			case MatchMachineState.InvalidMatch: {
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a ExitMatch. Exiting matching state.',
				);
			}
				return;

			case MatchMachineState.StartedMatch: {
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a LeaderMatch. Entering matching state.',
				);
			}
				return;

			case MatchMachineState.RetainedMatch: {
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a RetainedMatch. Retaining matching state.',
				);
			}
				return;

			case MatchMachineState.ImprovedMatch: {
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a ImprovedMatch. Waiting for the rest of the key sequence.',
				);
			}
				return;

			case MatchMachineState.SuccessMatch: {
				event.preventDefault();
				writeConsole(
					'An keypress resulted in a FullMatch. Dispatching keymap.',
				);

				const keymap = this.matcher.fullMatch();
				this.invoke( keymap );
			}
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

		this.trie = new Trie();
		for ( const keymap of this.settings.hotkeys ) {
			writeConsole( 'Adding keymap ' + keymap.repr() );
			this.trie.add( keymap );
		}
		this.matcher = new MatchMachine( this.trie );
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

		this.addSettingTab( new LeaderSettingsTab( this ) );
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

const defaultHotkeys: KeyMap[]       = [
	new KeyMap( 'editor:focus-left', [ KeyPress.ctrl( 'b' ), KeyPress.just( 'h' ) ] ),
	new KeyMap( 'editor:focus-right', [ KeyPress.ctrl( 'b' ), KeyPress.just( 'l' ) ] ),
	new KeyMap( 'editor:focus-top', [ KeyPress.ctrl( 'b' ), KeyPress.just( 'k' ) ] ),
	new KeyMap( 'editor:focus-bottom', [ KeyPress.ctrl( 'b' ), KeyPress.just( 'j' ) ] ),
	new KeyMap( 'command-palette:open', [
		KeyPress.ctrl( 'q' ),
		KeyPress.just( '1' ),
		KeyPress.just( '2' ),
		KeyPress.just( '2' ),
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
const writeConsole                   = ( message: string ): void => {
	console.debug( ` Leader Hotkeys: ${ message }` );
};
