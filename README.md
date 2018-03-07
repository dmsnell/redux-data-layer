# Fetchable Data

One of the common problems within the React and Redux ecosystem is managing data coming from remote or asynchronous sources.
This library exists to provide a robust solution to this problem; a solution which meets the following needs:

- Abstract the fetching of data from requesting it
- Define clear data types and transform incoming data into these types
- Differentiate declarative requests from imperative fetches
- Dynamically manage data models in a way that allows for code-splitting
- Remove overhead required for one-off or rarely-requests tasks
- Store metadata about requests which take time to complete and may fail
- Update React components along the lifecycle changes of data requests

This library is the product of reflection and growing understanding from the data needs in Automattic/wp-calypso.

## High-level concepts

### Identifiers

Different kinds of data are referenced by a unique identifier.
This identifier captures two elements: the _type_ of data and its unique id within that type.
For example, an object representing a "user" might be given an identifier composed of the string "user" for its type and the user id as the unique id.

```js
new Identifier( 'user', `${ userId }` )
```

The identifier will be used for a few separate purposes:

- Request data already in memory
- Indicate where to store new updates from fetchable sources
- Key the optimization of prop updates for performer

We won't usually create identifiers directly; instead we'll prefer to write our own wrappers to encapsulate data-type-specific details.

```js
/** @module ids */

export const user = userId =>
    new Identifier( 'user', `${ userId }` );

export const product = ( userId, productId ) =>
    new Identifier( 'product', `${ userId }-${ productId }` );
```

Not every identifier needs a type though.
In some cases (to be seen later on) we will want an identifier for a unique operation.
We don't care specifically what the identifier is, only that it's unique.

```js
export const unique = o =>
    new Identifier( null, JSON.stringify( o ) );
```

### Data models

Data models encode a specific _type_ or _kind_ of data or request in our application.
For every kind of data we will consume we want to create a new type.
The type contains all the required metadata for the data being fetched:

- identifier for the data
- how to fetch the data
- how to handle a successful load
- how to handle a failed load
- how to handle partial loads
- special options for the type

Each handler in the data type produces a list of `actions` and `updates`.
If only a single action or update is required then there is no need to return a list (as a shorthand syntax).
An `action` is a Redux action which should be fed into the dispatcher.
An `update` is a direct update to data in the database that `fetchable-data` manages.

Note that the data model can thus be used both to fetch data or resources and also to update them.
In the one case we provide a way to get the information from a remote source but in the other it's a way to remotely update.

Communication through the data lifecycles will need to occur through the `fetchable-task` interface: a Redux action with specific payload formats to indicate the lifecycle and associated data.
For example, if dispatching a description for a network request then we would need to translate the response of that network request into an action of the `fetchable-task` type and load the network request's response body into the `data` or `error`.

#### Updates

Updates are the mechanism through which the database is updated in response to various actions from the data models.
An update is a pair of an identifier (which indicates where the update should be stored) and a value to be stored.
The updates themselves are failable-parsers.
Errors are caught during their execution and transform a successful update into a failure update.

For example, if we wanted to set the lap-time of a racer in resopnse to an API call we would provide an update in the `success` handler which pulls it from the network request body.

```js
const lapTime = userId => new DataType( {
    id: ids.lapTime( userId ),
    initiator: apiCall( `/users/${ userId }/lapTime` ),
    onSuccess: data => [
        ids.lapTime( userId ),
        parseFloat( data.payload.lap_time )
    ]
} )
```

If no handler is provided then we'll take the default behavior which is to copy the data of the successful task completion or the error of the failed completion into the data type's id.

Noteworthy is that we have freedom to split a task's response into separate updates to the data in memory.
We might imagine requesting a list of posts for a given site.
In this case we might want to be able to recall the list of poss for the given site just as we might want to be able to access the posts individually.
We can see how this is done via multiple updates.

```js
onSuccess: data => [
    [
        ids.sitePostList( siteId ),
        data.posts.map( p => p.id ) 
    ],
    ...data.posts.map( post => [
        ids.sitePost( siteId, post.id ),
        post
    ] )
]
```

This example illustrates how we can flatten an otherwise-nested data structure in memory.
For each relationship we have we can create the equivalent join table.
In this case it was changing `sites[ siteId ].posts` into `sitePosts[ siteId ]` and `posts[ siteId + '-' + postId ]`.

An update can _replace_ or _update_ existing data.
Without any other indication an update will replace the existing data.
However, if we turn the value into a function it will give us the previous value to update.

```js
onSuccess: data => [
    [
        ids.sitePostList( siteId ),
        prevPosts => union( prevPosts, data.posts.map( p => p.id ) ),
    ],
    ...data.posts.map( post => [
        ids.sitePost( siteId, post.id ),
        post
    ] )
]
```

In this example we merged the new posts for the site into the existing list.

Optimistic updates then involve a mixture of updates and actions.

```js
const postLike = ( siteId, postId, isLiked = true ) => new DataType( {
    id: ids.postLike( siteId, postId ),
    initiator: [
        [
            ids.postLike( siteId, postId ),
            isLiked
        ],
        {
            type: 'API_REQUEST',
            method: 'POST',
            apiVersion: '1.1',
            path: `/sites/${ siteId }/posts/${ postId }/likes/new`
        }
    ],
    onSuccess: data => [
        [
            ids.postLike( siteId, postId ),
            Boolean( data.is_liked )
        ]
    ],
    onFailure: error => [
        [
            ids.postLike( siteId, postId ),
            ! isLiked
        ],
        {
            type: 'ERROR_NOTICE',
            message: 'Failed to like post.'
        }
    ]
} )
```

### Requests

Requests are littl more than a specific identifier.
They are used to extract data already in memory as well as the metadata about data which may or may not have already been loaded.

In the wrapper the `request` object specifies which data will be passed into the React component and which prop key that data will populate.

Beyond that prop itself the metadata will also be available at the same key in the `dataRequests` prop.

For example, if we wanted to supply a given `applicant` to our React component, we would give it a key and use its identifier.

```js
const resourceMap = ( state, { applicantId } ) => ( {
    request: {
        applicant: ids.applicant( applicantId )
    }
} )
```

Our React component can then access `this.props.applicant` which will be `undefined` if not yet available or some value if it is.
If we access `this.props.dataRequests.applicant` we can then determine what state the request is in.

```js
render() {
    const {
        applicant,
        dataRequests: { applicant: { state } }
    } = this.props;

    if ( undefined === applicant ) {
        return <Placeholder />;
    }

    return (
        <>
            { state === 'pending' && <LoadingSpinner /> }
            <Form>
                <Field name="name" value={ applicant.name } />
                <SaveButton />
            </Form>
        </>
    );
}
```

Even if we haven't attempted to fetch the data yet we can still request its value.
For example, we might want to indicate if some large data structure has been fetchd or if some long-running task has been started.
If no attempt has been made to initialize the data type then we will get the `uninitialized` state back.

```js
const { dataRequests: meta } = this.props;
const hasStarted = 'uninitialized' === meta.applyFilter.state;
```

### Performers

Unlike `requests` which are for retrieving stored data from memory, `performers` _do_ something imperatively.
We already saw one in the example data type above for `postLike`.

Performers are passed into a wrapped React component much like how `requests` are but they look different in their declaration.
They are a pair of items: the first is any string which serves as a cache key for the function acting as the performer; the second is the function itself.
We use a cache key to prevent needless re-renders since these functions are created on every `render()`.

Performers can take no or many arguments and produce a data type.
When called from inside a React component they will run their `initiate` handler to trigger the fetchable task.

## Data lifecycle

Data requests, like React components, have lifecycle.
They can represent network fetches, `setTimeout()` delays or promise resolutions, asynchronous work in separate Web Workers, or any other asynchronous fetch.
The lifecycle methods are managed by the `fetchable-data` system and rely on the `fetchable-task` Redux action wrapping data changes and updates.

### Lifecycle states

`uninitialized` means that we haven't yet requested the data or task.
It has no other information, no data, no error, and no `lastAttempt` or partial progress.
It's `lastUpdated` value is `-Infinity`.

`pending` means that we're in th emiddle of a request and waiting to hear back.
If this is transitioning us out of `uninitialized` then the only other value that will exist is `lastAttempted` which will be set to the time we started fetching.

We may have already requested this data and we might be `pending` again.
In this case we'll keep the previous values of the `data` and `error` and `lastUpdated` fields.
That is, waiting for new data should not eliminate data we already received.

If partial updates come in while requesting the data then we'll additionally have the `loaded` and `total` values representing progress in the request.

`success` means that the data request fulfilled successfully and the returned `data` is available.
The `lastUpdated` value will update and th `error` will clear (because the most-recent operation wasn't a failure).

`failure` means that the data request failed to fulfill.
The `lastUpdated` will remain the same since the data didn't update.
Additionally a failure will not clear out the `data`.
In many cases we will want to continue to use data we previously requested successfully even if newer updates failed.

### Freshness

In many cases we want to poll for information.
We may pre-emptively poll for updates to an API endoint or periodically recompute some application state.
In these cases we introduce the concept of `freshness` to represent a tolerated level of data staleness before refreshing the data.
Since all data is asynchronously fetched we can assume that every bit of data entering the application is already stale to some extent.
The data at its source could have changed in the time it took to reach our app.
Different types of data also have different staleness needs: historical stock values may never expire and thus can be infinitely stale while the _current_ stock value may update by the second.
For the historical data we can mark its freshness as `Infinity` while for the current data we can mark its freshness as something like `1000ms`.

```js
const historicalValue = ( symbol, date ) => new DataType( {
    id: ids.stockValue( symbol, date ),
    initiator: fetch( symbol, date ),
    onSuccess: data => [
        [
            ids.stockValue( symbol, date ),
            data.price
        ]
    ],
    options: { freshness: Infinity }
} )

const currentValue = symbol => new DataType( {
    id: ids.stockValue( symbol ),
    initiator: fetch( symbol, Date.now() ),
    onSuccess: data => [
        [
            ids.stockValue( symbol, Date.parse( data.date ) ),
            data.price
        ]
    ],
    options: { freshness: 1000 }
} )
```

Now when any of these values are requested by a React component the historical value will fetch once and never update while the current value will fetch an update once each second as long as the component is rendering.

## React wrapper

React component interact with the fetchable data through the wrapping higher-order component.
This component manages updating the requested data and providing the values of that data and the performers to the wrapped component.

The wrapper depends on having the `redux` store available in React's `context`.

```js
const resourceMap = ( state, { siteId, postId } ) => ( {
    request: {
        postIsLiked: ids.postLike( siteId, postId )
    },
    perform: {
        likePost: [
            ids.postLike( siteId, postId ),
            () => types.likePost( siteId, postId )
        ]
    }
} )

export default performing( resourceMap )( connect( mapStateToProps, mapDispatchToProps )( MyComponent ) );
```

Since the wrapper itself uses `connect` you can additionally pass in the normal `mapStateToProps` and `mapDispatchToProps` parameters in and it will inject them for you.

```js
export default performing( resourceMap, mapStateToProps, mapDispatchToProps, mergeProps, options )( MyComponent );
```

Freshness constraints are handled automatically so that data is always at least as up-to-date as the component demands if indeed it's possible to have it that fresh.

There's no need to manually fetch the data because the wrapper will ensure that requested data is loaded into memory.

## Store enhancer

The pieces to this system are connected via the Redux store enhancer which tracks fetchable tasks and dispatches data requests.

This will need to be applied when creating your Redux store.

```js
import { createStore } from 'redux';
import { enhancer as fetchableTasks } from 'fetchable-tasks';

const store = createStore( reducer, initialState, fetchableTasks );
```
