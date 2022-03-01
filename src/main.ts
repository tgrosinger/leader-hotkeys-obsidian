import { App, Keymap, Modal, Notice, Plugin, PluginSettingTab, Scope, Setting } from 'obsidian';

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

// interface ObsidianApp {
//   // todo
//   appId: string;
//   account;
//   commands;
//   customCss;
//   dom;
//   dragManager;
//   fileManager;
//   foldManager;
//   hotkeyManager;
//   internalPlugins;
//   isMobile;
//   keymap;
//   lastEvent;
//   loadProgress;
//   metadataCache;
//   mobileToolbar;
//   nextFrameEvents;
//   nextFrameTimer;
//   plugins;
//   scope;
//   setting;
//   shareReceiver;
//   statusBar;
//   vault;
//   viewRegistry;
//   workspace;
// }

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
	public static from<K extends HashIter>( iter: K[] ): Trie<K> {
		const trie = new Trie<K>();
		trie.addAll( iter );
		return trie;
	}

	private readonly root: TrieNode<T>;

	constructor() {
		this.root = new TrieNode();
	}

	public addAll( iter: T[] ): Trie<T> {
		for ( const item of iter ) {
			this.add( item );
		}
		return this;
	}

	public add( composite: T ): Trie<T> {
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
		return this;
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

	public readonly text                  = (): string => {
		const metaRepr  = this.meta ? '⌘ + ' : '';
		const altRepr   = this.alt ? 'Alt + ' : '';
		const ctrlRepr  = this.ctrl ? 'Ctrl + ' : '';
		const shiftRepr = this.shift ? '⇧ + ' : '';


		return metaRepr + ctrlRepr + altRepr + shiftRepr + this.key;
	};
	public readonly elementRepresentation = (): HTMLElement => {
		const result = document.createElement( 'kbd' )
		result.addClass( 'setting-hotkey' )
		result.setText( this.text() )
		result.style.padding = '2px'
		result.style.margin  = '5px'

		result.style.border       = '1px solid rgba(255,255,255,.25)'
		result.style.borderRadius = '3px'
		return result

	}
	public readonly serialize             = (): string => {
		return this.text();
	};

	public readonly classification = (): PressType => {
		if (
			this.key === null ||
			this.key === undefined ||
			this.key === 'Alt' ||
			this.key === 'Control' ||
			this.key === 'Shift' ||
			this.key === 'Meta' ||
			this.key === 'AltGraph'
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

	public fullRepr = (): string => {
		return this.commandID + ' = ' + this.sequenceRepr();
	};

	public sequenceRepr = (): string => {
		return this.sequence.map( ( key ) => key.text() ).join( ' => ' );
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
	DeletedKey,
	PendingAddition,
	PendingDeletion,
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
			case RegisterMachineState.FirstKey:
			case RegisterMachineState.RetainedKeys:
			case RegisterMachineState.DeletedKey:
			case RegisterMachineState.AddedKeys:
				if ( classification === PressType.NoKey ) {
					this.currentState = RegisterMachineState.RetainedKeys;
				} else if ( classification === PressType.SpecialKey ) {
					this.currentSequence.push( event )
					this.currentState = event.key === 'Enter'
										? RegisterMachineState.PendingAddition
										: RegisterMachineState.PendingDeletion;
				} else {
					this.currentSequence.push( event );
					this.currentState = this.currentSequence.length === 1
										? RegisterMachineState.FirstKey
										: RegisterMachineState.AddedKeys;

				}
				return this.currentState;

			case RegisterMachineState.PendingDeletion:
				if ( event.key === 'Enter' && event.ctrl && event.alt ) {
					this.currentSequence.pop();
					this.currentState = RegisterMachineState.FinishedRegistering;
				} else if ( event.key === 'Enter' ){
					this.currentState = RegisterMachineState.AddedKeys;
				}
				else {
					this.currentSequence.pop();
					this.currentSequence.pop()
					this.currentState = RegisterMachineState.DeletedKey;
				}
				return this.currentState;

			case RegisterMachineState.PendingAddition:
				if ( event.key === 'Enter' && event.ctrl && event.alt ) {
					this.currentSequence.pop();
					this.currentState = RegisterMachineState.FinishedRegistering;
				} else if ( event.key === 'Enter' ){
					this.currentState = RegisterMachineState.AddedKeys;
				}
				else {
					this.currentSequence.pop();
					this.currentState = RegisterMachineState.RetainedKeys;
				}
				return this.currentState;

			case RegisterMachineState.FinishedRegistering: {
				this.reset();
				return this.advance( event );
			}
		}
	};

	public readonly presses                = (): readonly KeyPress[] => {
		return this.currentSequence;
	};
	public readonly documentRepresentation = (): HTMLElement[] => {
		return this.presses().map( press => press.elementRepresentation() )
	}

	private readonly reset = (): void => {
		this.currentState    = RegisterMachineState.NoKeys;
		this.currentSequence = [];
	};


}

class KeymapRegisterer extends Modal {

	private readonly parent: LeaderSettingsTab;
	private readonly registerMachine: RegisterMachine;
	private readonly commandId: string;


	constructor( parent: LeaderSettingsTab, commandId: string ) {
		super( parent.app );
		this.parent          = parent;
		this.commandId       = commandId;
		this.registerMachine = new RegisterMachine();
	}

	public readonly onOpen = (): void => {
		this.renderKeyPresses( this.registerMachine.documentRepresentation() )
		document.addEventListener( 'keydown', this.handleKeyDown );
	};

	public readonly onClose = (): void => {
		document.removeEventListener( 'keydown', this.handleKeyDown );
		this.parent.display();
	};

	private readonly handleKeyDown = ( event: KeyboardEvent ): void => {

		event.preventDefault();
		const keyPress      = KeyPress.fromEvent( event );
		const registerState = this.registerMachine.advance( keyPress );
		writeConsole( `An keypress resulted in ${ RegisterMachineState[ registerState ] } state.`, );


		switch ( registerState ) {
			case RegisterMachineState.NoKeys:
			case RegisterMachineState.RetainedKeys:
			case RegisterMachineState.FirstKey:
			case RegisterMachineState.DeletedKey:
			case RegisterMachineState.AddedKeys:
				this.renderKeyPresses( this.registerMachine.documentRepresentation() );
				return;

			case RegisterMachineState.PendingDeletion: {
				// Inplace mutation :(
				const elements            = this.registerMachine.documentRepresentation()
				const lastElement         = elements[ elements.length - 1 ];
				lastElement.style.opacity = '0.5'
				this.renderKeyPresses( elements );


				const backspace            = KeyPress.just( 'Backspace' ).elementRepresentation()
				const enter                = KeyPress.just( 'Enter' ).elementRepresentation()
				const ctrlAltEnter         = KeyPress.ctrlAlt( 'Enter' ).elementRepresentation()
				const pressLiteral         = lastElement.cloneNode( true )
				pressLiteral.style.opacity = '1'

				const confirmText = document.createElement( 'p' );
				confirmText.append( 'Did you mean literal ', pressLiteral, '?',
									document.createElement( 'br' ),
									'If so, press ', enter, '.',
									document.createElement( 'br' ),
									'If not, discard it with ', backspace, '.',
									document.createElement( 'br' ),
									'If you wanted to complete, press ', ctrlAltEnter )


				this.contentEl.append( confirmText );
			}
				return
			case RegisterMachineState.PendingAddition: {
				// Inplace mutation :(
				const elements            = this.registerMachine.documentRepresentation()
				const lastElement         = elements[ elements.length - 1 ];
				lastElement.style.opacity = '0.5'
				this.renderKeyPresses( elements );


				const backspace            = KeyPress.just( 'Backspace' ).elementRepresentation()
				const enter                = KeyPress.just( 'Enter' ).elementRepresentation()
				const ctrlAltEnter         = KeyPress.ctrlAlt( 'Enter' ).elementRepresentation()
				const pressLiteral         = lastElement.cloneNode( true )
				pressLiteral.style.opacity = '1'

				const confirmText = document.createElement( 'p' );
				confirmText.append( 'Did you mean literal ', pressLiteral, '?',
									document.createElement( 'br' ),
									'If so, press ', enter, '.',
									document.createElement( 'br' ),
									'If not, discard it with ', backspace, '.',
									document.createElement( 'br' ),
									'If you wanted to complete, press ', ctrlAltEnter )


				this.contentEl.append( confirmText );
			}
				return;

			case RegisterMachineState.FinishedRegistering:
				const keyPresses = [ ...this.registerMachine.presses() ];
				const conflicts  = this.parent.conflicts( keyPresses );
				if ( conflicts.length > 0 ) {
					this.setText(
						'This sequence conflicts with other sequences [ . . . ] . Please try again.',
					);
				} else {
					const keymap = new KeyMap( this.commandId, keyPresses );
					this.parent.addKeymap( keymap );
					new Notice( `Command  ${ this.commandId } can now be invoked by ${ keymap.sequenceRepr() }` );
					this.close();
				}
		}
	};

	private readonly renderKeyPresses = ( elements: HTMLElement[] ): void => {
		this.contentEl.empty();

		const header = document.createElement( 'p' )
		header.setText( `Registering for ${ this.commandId }` );

		const introText = document.createElement( 'div' );
		introText.addClass( 'setting-hotkey' )
		introText.style.overflow = 'auto';
		introText.append( ...elements )
		// introText.appendChild( k )

		this.contentEl.appendChild( header );
		this.contentEl.appendChild( introText );

	}

	private readonly setText = ( text: string ): void => {
		this.renderKeyPresses( text )
	};
}

// endregion

class CommandModal extends Modal {
	private readonly parent: LeaderSettingsTab;
	private commandId: string;

	constructor( parent: LeaderSettingsTab ) {
		super( parent.app );
		this.parent = parent;
	}

	public onOpen(): void {


		const setting = new Setting( this.contentEl );

		setting.addDropdown( ( dropdown ) => {
			dropdown.selectEl.addClass( 'leader-hotkeys-command' );

			for ( const command of this.parent.obsidianCommands() ) {
				dropdown.addOption( command.id, command.name );
			}

			const placeHolder = new Option( 'Select a Command', 'placeholder', true );
			placeHolder.setAttribute( 'disabled', 'true' );
			placeHolder.setAttribute( 'selected', 'true' );
			placeHolder.setAttribute( 'hidden', 'true' );
			dropdown.selectEl.append( placeHolder )

			dropdown.setValue( 'placeholder' )
			dropdown.onChange( ( selectedId ) => {
				this.commandId = selectedId;
			} );
			dropdown.selectEl.focus()

		} );

		setting.addButton( ( button ) => {
			button.setButtonText( 'OK' );
			button.onClick( () => {

				if ( this.commandId === null || this.commandId === undefined || this.commandId === '' ) {
					new Notice( 'Select a command to register' );
					return;
				}

				const registerer = new KeymapRegisterer( this.parent, this.commandId );
				registerer.open();
				this.close();

			} );

		} );
	}
}

class LeaderSettingsTab extends PluginSettingTab {
	public commands: ObsidianCommand[];
	private readonly plugin: LeaderHotkeys;

	constructor( plugin: LeaderHotkeys ) {
		super( plugin.app, plugin );
		this.plugin = plugin;
		this.app    = plugin.app;
	}

	public display(): void {
		this.refreshCommands()

		const containerEl = this.containerEl;
		containerEl.empty();
		containerEl.createEl( 'h2', { text: 'Leader Hotkeys Plugin - Settings' } );

		containerEl.createEl( 'h3', { text: 'Existing Hotkeys' } );
		for ( let i = 0; i < this.currentKeymaps().length; i++ ) {
			this.displayExisting( i );
		}

		new Setting( containerEl ).addButton( ( button ) => {
			button.setButtonText( 'New Keymap' ).onClick( () => {
				new CommandModal( this ).open();
			} );
		} );
	}

	public refreshCommands(): void {
		this.commands = listCommands( this.app );
	}

	public conflicts( keyPresses: KeyPress[] ): KeyMap[] {

		return this.plugin.matchKeymap( keyPresses ) || [];
	}

	public obsidianCommands(): ObsidianCommand[] {
		return this.commands;
	}

	public addKeymap( keymap: KeyMap ): void {
		writeConsole( `Adding keymap: ${ keymap.fullRepr() }` );

		const newHotkeys = [ ...this.currentKeymaps() ].concat( keymap );

		this.saveKeymap( newHotkeys );
	}

	public removeKeymap( positionId: number ): void {
		const currentHotkeys = this.currentKeymaps();
		const toRemove       = currentHotkeys[ positionId ];
		writeConsole( `Removing keymap: ${ toRemove.fullRepr() }` );

		const newKeymap = [];
		for ( let i = 0; i < currentHotkeys.length; i++ ) {
			if ( i !== positionId ) {
				newKeymap.push( currentHotkeys[ i ] );
			}
		}

		this.saveKeymap( newKeymap );
	}

	public updateKeymap( positionId: number, keyMap: KeyMap ): void {
		writeConsole(
			`Updating keymap at position ${ positionId }: ${ keyMap.fullRepr() }`,
		);
		const keyMaps         = [ ...this.currentKeymaps() ];
		keyMaps[ positionId ] = keyMap;
		this.saveKeymap( keyMaps );
	}

	private saveKeymap( keymaps: KeyMap[] ): void {
		this.plugin.saveKeymaps( keymaps );
	}

	private displayExisting( positionId: number ): void {
		const containerEl = this.containerEl;
		const thisKeymap  = this.currentKeymaps()[ positionId ];

		const setting = new Setting( containerEl );
		setting.addDropdown( ( dropdown ) => {
			for ( const command of this.commands ) {
				dropdown.addOption( command.id, command.name );
			}
			dropdown.onChange( ( newCommand ) => {
				const newKeyMap     = KeyMap.of( thisKeymap );
				newKeyMap.commandID = newCommand;
				this.updateKeymap( positionId, newKeyMap );
			} );

			dropdown.setValue( thisKeymap.commandID );
			dropdown.selectEl.addClass( 'leader-hotkeys-command' );
		} );
		setting.addExtraButton( ( button ) => {
			button
				.setIcon( 'cross' )
				.setTooltip( 'Delete shortcut' )
				.extraSettingsEl.addClass( 'leader-hotkeys-delete' );

			button.onClick( () => {
				this.removeKeymap( positionId );
				this.display();
			} );
		} );
		setting.infoEl.remove();
		const settingControl = setting.settingEl.children[ 0 ];


		const keySetter = document.createElement( 'div' );
		keySetter.addClass( 'setting-hotkey' );

		const kbds = thisKeymap.sequence.map( press => press.elementRepresentation() )
		keySetter.append( ...kbds );

		keySetter.addEventListener( 'click', ( e: Event ) =>
			new KeymapRegisterer( this, thisKeymap.commandID ).open(),
		);

		settingControl.insertBefore( keySetter, settingControl.children[ 0 ] );

		const appendText = document.createElement( 'span' );
		appendText.addClass( 'leader-hotkeys-setting-append-text' );
		appendText.setText( 'to' );
		settingControl.insertBefore( appendText, settingControl.children[ 1 ] );
	}

	private currentSettings(): SavedSettings {
		return this.plugin.settings;
	}

	private currentKeymaps(): KeyMap[] {
		return this.currentSettings().hotkeys;
	}
}

export default class LeaderHotkeys extends Plugin {

	public settings: SavedSettings;
	private settingsTab: LeaderSettingsTab;
	private trie: Trie<KeyMap>;
	private matcher: MatchMachine;

	public async onload(): Promise<void> {
		writeConsole( 'Started Loading.' );

		await this.loadSavedSettings();
		await this.registerEventsAndCallbacks();

		this.settingsTab = new LeaderSettingsTab( this );
		this.addSettingTab( this.settingsTab );
		writeConsole( 'Registered Setting Tab.' );

		writeConsole( 'Finished Loading.' );
	}

	public onunload(): void {
		writeConsole( 'Unloading plugin.' );
	}

	public matchKeymap( presses: KeyPress[] ): KeyMap[] {
		const matches = this.trie.bestMatch( presses );
		return matches ? matches.leafValues() : [];
	}

	public saveKeymaps( keymaps: KeyMap[] ): void {
		const keyMapString = keymaps.map( ( keymap ) => keymap.fullRepr() ).join( '\n' );
		writeConsole( `Saving keymap: ${ keyMapString }` );

		this.settings.hotkeys = keymaps;
		this.saveData( this.settings )
			.then( () => {
				new Notice( 'Successfully Saved keymaps.' );
				// todo notify
			} )
			.catch( () => {
				new Notice( 'Error while Saving Keymaps.' );
				//	todo notify
			} );


		this.trie    = Trie.from( keymaps );
		this.matcher = new MatchMachine( this.trie );
	}

	private readonly handleKeyDown = ( event: KeyboardEvent ): void => {

		const keypress     = KeyPress.fromEvent( event );
		const currentState = this.matcher.advance( keypress );
		switch ( currentState ) {
			case MatchMachineState.NoMatch:

				writeConsole( `An keypress resulted in a ${ MatchMachineState[ currentState ] } state.` )
				return

			case MatchMachineState.RetainedMatch:
			case MatchMachineState.StartedMatch:
			case MatchMachineState.InvalidMatch:
			case MatchMachineState.ImprovedMatch:
				event.preventDefault();
				writeConsole( `An keypress resulted in a ${ MatchMachineState[ currentState ] } state.` )
				return;

			case MatchMachineState.SuccessMatch:
				event.preventDefault();
				writeConsole( `An keypress resulted in a ${ MatchMachineState[ currentState ] } state.` )
				const keymap = this.matcher.fullMatch();
				this.invoke( keymap );
				return;
		}

	};

	private async registerEventsAndCallbacks(): Promise<void> {
		writeConsole( 'Registering necessary event callbacks' );

		const workspaceContainer = this.app.workspace.containerEl;
		this.registerDomEvent( workspaceContainer, 'keydown', this.handleKeyDown );
		writeConsole( 'Registered workspace "keydown" event callbacks.' );


		const openModalCommand = {
			id:       'register-modal',
			name:     'Open Register Modal',
			callback: () => {

				this.settingsTab.refreshCommands()
				new CommandModal( this.settingsTab ).open()
				//	need something here.
			},
		};
		this.addCommand( openModalCommand );
		writeConsole( 'Registered open modal command' );
	}

	private async loadSavedSettings(): Promise<void> {
		writeConsole( 'Loading previously saved settings.' );

		const savedSettings = await this.loadData();

		if ( savedSettings ) {
			writeConsole( 'Successfully loaded previous settings.' );
		} else {
			writeConsole(
				'No saved settings were found, default ones will be used instead.',
			);
		}

		this.settings         = savedSettings || defaultSettings;
		this.settings.hotkeys = this.settings.hotkeys.map( KeyMap.of )

		this.trie    = Trie.from( this.settings.hotkeys );
		this.matcher = new MatchMachine( this.trie );


	}

	private invoke( keymap: Optional<KeyMap> ): void {

		if ( keymap ) {
			// todo remove any typing
			const app = this.app as any;
			app.commands.executeCommandById( keymap.commandID );
		} else {
			writeConsole(
				'No keymap found for the full match. This is definitely a bug.',
			);
		}
	}
}

const listCommands                   = ( app: App ): ObsidianCommand[] => {
	// todo remove any type
	const anyApp               = app as any;
	const commands: CommandMap = anyApp.commands.commands;
	return Object.values( commands );
};
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
