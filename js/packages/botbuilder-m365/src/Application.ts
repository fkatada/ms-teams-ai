/**
 * @module botbuilder-m365
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { TurnContext, Storage, ActivityTypes} from 'botbuilder';
import { TurnState, TurnStateManager } from './TurnState';
import { DefaultTurnState, DefaultTurnStateManager } from './DefaultTurnStateManager';
import { AdaptiveCards, AdaptiveCardsOptions } from './AdaptiveCards';
import { MessageExtensions } from './MessageExtensions';
import { PredictionEngine } from './PredictionEngine';
import { AI } from './AI';

const TYPING_TIMER_DELAY = 1000;

export interface Query<TParams extends Record<string, any>> {
    count: number;
    skip: number;
    parameters: TParams;
}

export interface ApplicationOptions<TState extends TurnState, TPredictionOptions, TPredictionEngine extends PredictionEngine<TState, TPredictionOptions>> {
    storage?: Storage;
    predictionEngine?: TPredictionEngine; 
    turnStateManager?: TurnStateManager<TState>;
    adaptiveCards?: AdaptiveCardsOptions;
    removeRecipientMention?: boolean;
    startTypingTimer?: boolean;
}

export type RouteSelector = (context: TurnContext) => Promise<boolean>;
export type RouteHandler<TState extends TurnState> = (context: TurnContext, state: TState) => Promise<void>;

export type ConversationUpdateEvents = 'channelCreated' | 'channelRenamed' | 'channelDeleted' | 'channelRestored' | 'membersAdded' | 'membersRemoved' | 'teamRenamed' | 'teamDeleted' | 'teamArchived' | 'teamUnarchived' | 'teamRestored';
export type MessageReactionEvents = 'reactionsAdded' | 'reactionsRemoved';

export class Application<TState extends TurnState = DefaultTurnState, TPredictionOptions = any, TPredictionEngine extends PredictionEngine<TState, TPredictionOptions> = PredictionEngine<TState, TPredictionOptions>> {
    private readonly _options: ApplicationOptions<TState, TPredictionOptions, TPredictionEngine>;
    private readonly _routes: AppRoute<TState>[] = [];
    private readonly _invokeRoutes: AppRoute<TState>[] = [];
    private readonly _adaptiveCards: AdaptiveCards<TState>;
    private readonly _messageExtensions: MessageExtensions<TState>;
    private readonly _ai?: AI<TState, TPredictionOptions, TPredictionEngine>;
    private _typingTimer: any;

    public constructor(options?: ApplicationOptions<TState, TPredictionOptions, TPredictionEngine>) {
        this._options = Object.assign({
            removeRecipientMention: true,
            startTypingTimer: true
        } as ApplicationOptions<TState, TPredictionOptions, TPredictionEngine>, options) as ApplicationOptions<TState, TPredictionOptions, TPredictionEngine>;
        
        // Create default turn state manager if needed
        if (!this._options.turnStateManager) {
            this._options.turnStateManager = new DefaultTurnStateManager() as any;
        }

        // Create AI component if configured with a prediction engine
        if (this._options.predictionEngine) {
            this._ai = new AI(this, this._options.predictionEngine);
        }

        this._adaptiveCards = new AdaptiveCards<TState>(this);
        this._messageExtensions = new MessageExtensions<TState>(this);
    }

    public get adaptiveCards(): AdaptiveCards<TState> {
        return this._adaptiveCards;
    }

    public get ai(): AI<TState, TPredictionOptions, TPredictionEngine> {
        if (!this._ai) {
            throw new Error(`The Application.ai property is unavailable because no PredictionEngine was configured.`);
        }

        return this._ai;
    }

    public get messageExtensions(): MessageExtensions<TState> {
        return this._messageExtensions;
    }

    public get options(): ApplicationOptions<TState, TPredictionOptions, TPredictionEngine> {
        return this._options;
    }


    /**
     * Adds a new route to the application.
     *
     * @remarks
     * Routes will be matched in the order they're added to the application. The first selector to
     * return `true` when an activity is received will have its handler called.
     * @param selector Function used to determine if the route should be triggered.
     * @param handler Function to call when the route is triggered.
     * @param isInvokeRoute boolean indicating if the RouteSelector checks for "Invoke" Activities as part of its routing logic. Defaults to `false`.
     * @returns The application instance for chaining purposes.
     */
    public addRoute(selector: RouteSelector, handler: RouteHandler<TState>, isInvokeRoute: boolean = false): this {
        if (isInvokeRoute) {
            this._invokeRoutes.push({ selector, handler });
        } else {
            this._routes.push({ selector, handler });
        }
        return this;
    }

    /**
     * Handles incoming activities of a given type.
     * @param type Name of the activity type to match or a regular expression to match against the incoming activity type. An array of type names or expression can also be passed in.
     * @param handler Function to call when the route is triggered.
     * @returns The application instance for chaining purposes.
     */
    public activity(type: string|RegExp|RouteSelector|(string|RegExp|RouteSelector)[], handler: (context: TurnContext, state: TState) => Promise<void>): this {
        (Array.isArray(type) ? type : [type]).forEach((t) => {
            const selector = createActivitySelector(t);
            this.addRoute(selector, handler);
        });
        return this;
    }

    /**
     * Handles conversation update events.
     * @param event Name of the conversation update event to handle.
     * @param handler Function to call when the route is triggered.
     * @returns The application instance for chaining purposes.
     */
    public conversationUpdate(event: ConversationUpdateEvents|ConversationUpdateEvents[], handler: (context: TurnContext, state: TState) => Promise<void>): this {
        (Array.isArray(event) ? event : [event]).forEach((e) => {
            const selector = createConversationUpdateSelector(e);
            this.addRoute(selector, handler);
        });
        return this;
    }

    /**
     * Handles incoming messages with a given keyword.
     * @param keyword Substring of text or a regular expression to match against the text of an incoming message. An array of keywords or expression can also be passed in.
     * @param handler Function to call when the route is triggered.
     * @returns The application instance for chaining purposes.
     */
    public message(keyword: string|RegExp|RouteSelector|(string|RegExp|RouteSelector)[], handler: (context: TurnContext, state: TState) => Promise<void>): this {
        (Array.isArray(keyword) ? keyword : [keyword]).forEach((k) => {
            const selector = createMessageSelector(k);
            this.addRoute(selector, handler);
        });
        return this;
    }

    /**
     * Handles message reaction events.
     * @param event Name of the message reaction event to handle.
     * @param handler Function to call when the route is triggered.
     * @returns The application instance for chaining purposes.
     */
    public messageReactions(event: MessageReactionEvents|MessageReactionEvents[], handler: (context: TurnContext, state: TState) => Promise<void>): this {
        (Array.isArray(event) ? event : [event]).forEach((e) => {
            const selector = createMessageReactionSelector(e);
            this.addRoute(selector, handler);
        });
        return this;
    }

    public async run(context: TurnContext): Promise<boolean> {
        // Start typing indicator timer
        this.startTypingTimer(context);
        try {
            // Remove @mentions
            if (this._options.removeRecipientMention && context.activity.type == ActivityTypes.Message) {
                context.activity.text = TurnContext.removeRecipientMention(context.activity);
            }

            // Run any RouteSelectors in this._invokeRoutes first if the incoming activity.type is "Invoke".
            // Invoke Activities from Teams need to be responded to in less than 5 seconds.
            if (context.activity.type === ActivityTypes.Invoke) {
                for (let i = 0; i < this._invokeRoutes.length; i++) {
                    const route = this._invokeRoutes[i];
                    if (await route.selector(context)) {
                        // Load turn state
                        const { storage, turnStateManager } = this._options;
                        const state = await turnStateManager!.loadState(storage, context);

                        // Execute route handler
                        await route.handler(context, state);

                        // Save turn state
                        await turnStateManager!.saveState(storage, context, state);

                        // End dispatch
                        return true;
                    }
                }
            }

            // All other ActivityTypes and any unhandled Invokes are run through the remaining routes.
            for (let i = 0; i < this._routes.length; i++) {
                const route = this._routes[i];
                if (await route.selector(context)) {
                    // Load turn state
                    const { storage, turnStateManager } = this._options;
                    const state = await turnStateManager!.loadState(storage, context);

                    // Execute route handler
                    await route.handler(context, state);

                    // Save turn state
                    await turnStateManager!.saveState(storage, context, state);

                    // End dispatch
                    return true;
                }
            }

            // Call AI module if configured
            if (this._ai && context.activity.type == ActivityTypes.Message && context.activity.text) {
                // Load turn state
                const { storage, turnStateManager } = this._options;
                const state = await turnStateManager!.loadState(storage, context);

                // Begin a new chain of AI calls
                await this._ai.chain(context, state);

                // Save turn state
                await turnStateManager!.saveState(storage, context, state);

                // End dispatch
                return true;
            } 

            // activity wasn't handled
            return false;
        } finally {
            this.stopTypingTimer();
        }
    }

    /**
     * Manually start a timer to periodically send "typing" activities.
     * @remarks
     * The timer will automatically end once an outgoing activity has been sent. If the timer is 
     * already running or the current activity, is not a "message" the call is ignored.
     * @param context The context for the current turn with the user.
     */
    public startTypingTimer(context: TurnContext): void {
        if (context.activity.type == ActivityTypes.Message && !this._typingTimer) {
            // Listen for outgoing activities
            context.onSendActivities((context, activities, next) => {
                // Listen for any messages to be sent from the bot
                if (timerRunning) {
                    for (let i = 0; i < activities.length; i++) {
                        if (activities[i].type == ActivityTypes.Message) {
                            // Stop the timer
                            this.stopTypingTimer();
                            timerRunning = false;
                            break;
                        }
                    }
                }

                return next();
            });
            
            let timerRunning = true;
            const onTimeout = async () => {
                try {
                    // Send typing activity
                    await context.sendActivity({ type: ActivityTypes.Typing });
                } catch (err) {
                    // Seeing a random proxy violation error from the context object. This is because 
                    // we're in the middle of sending an activity on a background thread when the turn ends.
                    // The context object throws when we try to update "this.responded = true". We can just 
                    // eat the error but lets make sure our states cleaned up a bit.
                    this._typingTimer = undefined;
                    timerRunning = false;
                }

                // Restart timer
                if (timerRunning) {
                    this._typingTimer = setTimeout(onTimeout, TYPING_TIMER_DELAY);
                }
            };
            this._typingTimer = setTimeout(onTimeout, TYPING_TIMER_DELAY);
        }
    }

    /**
     * Manually stop the typing timer.
     * @remarks
     * If the timer isn't running nothing happens.
     */
    public stopTypingTimer(): void {
        if (this._typingTimer) {
            clearTimeout(this._typingTimer);
            this._typingTimer = undefined;
        }
    }
}

interface AppRoute<TState extends TurnState> {
    selector: RouteSelector;
    handler: RouteHandler<TState>;
}

function createActivitySelector(type: string|RegExp|RouteSelector): RouteSelector {
    if (typeof type == 'function') {
        // Return the passed in selector function
        return type;
    } else if (type instanceof RegExp) {
        // Return a function that matches the activities type using a RegExp
        return (context: TurnContext) => {
            return Promise.resolve(context?.activity?.type ? type.test(context.activity.type) : false);
        };
    } else {
        // Return a function that attempts to match type name
        const typeName = type.toString().toLocaleLowerCase();
        return (context: TurnContext) => {
            return Promise.resolve(context?.activity?.type ? context.activity.type.toLocaleLowerCase() === typeName : false);
        };
    }
}

function createConversationUpdateSelector(event: ConversationUpdateEvents): RouteSelector {
    switch (event) {
        case 'membersAdded':
            return (context: TurnContext) => {
                return Promise.resolve(context?.activity?.type == ActivityTypes.ConversationUpdate && Array.isArray(context?.activity?.membersAdded) && context.activity.membersAdded.length > 0);
            };
        case 'membersRemoved':
            return (context: TurnContext) => {
                return Promise.resolve(context?.activity?.type == ActivityTypes.ConversationUpdate && Array.isArray(context?.activity?.membersRemoved) && context.activity.membersRemoved.length > 0);
            };
        default: 
            return (context: TurnContext) => {
                return Promise.resolve(context?.activity?.type == ActivityTypes.ConversationUpdate && context?.activity?.channelData?.eventType == event);
            };
    }
}

function createMessageSelector(keyword: string|RegExp|RouteSelector): RouteSelector {
    if (typeof keyword == 'function') {
        // Return the passed in selector function
        return keyword;
    } else if (keyword instanceof RegExp) {
        // Return a function that matches a messages text using a RegExp
        return (context: TurnContext) => {
            if (context?.activity?.type === ActivityTypes.Message && context.activity.text) {
                return Promise.resolve(keyword.test(context.activity.text));
            } else {
                return Promise.resolve(false);
            }
        };
    } else {
        // Return a function that attempts to match a messages text using a substring
        const k = keyword.toString().toLocaleLowerCase();
        return (context: TurnContext) => {
            if (context?.activity?.type === ActivityTypes.Message && context.activity.text) {
                return Promise.resolve(context.activity.text.toLocaleLowerCase().indexOf(k) >= 0);
            } else {
                return Promise.resolve(false);
            }
        };
    }
}

function createMessageReactionSelector(event: MessageReactionEvents): RouteSelector {
    switch (event) {
        case 'reactionsAdded':
        default:
            return (context: TurnContext) => {
                return Promise.resolve(context?.activity?.type == ActivityTypes.MessageReaction && Array.isArray(context?.activity?.reactionsAdded) && context.activity.reactionsAdded.length > 0);
            };
        case 'reactionsRemoved':
            return (context: TurnContext) => {
                return Promise.resolve(context?.activity?.type == ActivityTypes.MessageReaction && Array.isArray(context?.activity?.reactionsRemoved) && context.activity.reactionsRemoved.length > 0);
            };
    }
}