import * as React from 'react';

class Database {
    constuctor() {
        this.db = new Map();
    }

    get( id ) {
        return Promise.resolve( this.db.get( id ) );
    }

    set( id, value ) {
        return Promise.resolve( this.db.set( id, value ) );
    }
}

const database = new Database();

class Identifier {
    constructor( type, id ) {
        this.type = type;
        this.id = id;
    }
}

class Resource {
    constructor( status, data, error, lastUpdated, lastAttempt, loaded, total ) {
        this.status = status;
        this.data = data;
        this.error = error;
        this.lastUpdated = lastUpdated;
        this.lastAttempt = lastAttempt;
        this.loaded = loaded;
        this.total = total;
    }

    succeed( data ) {
        const now = Date.now();

        return new Resource( 'success', data, undefined, now, now, null, null );
    }

    fail( error ) {
        return new Resource( 'failure', this.data, error, this.lastUpdated, this.lastAttempt, null, null );
    }

    update( data ) {
        return new Resource( 'pending', this.data, this.error, Date.now(), this.lastAttempt, data.loaded, data.total );
    }

    attempt() {
        return new Resource( 'pending', this.data, this.error, this.lastUpdated, Date.now(), null, null );
    }
}

const uninitialized = new Resource( 'uninitialized', undefined, undefined, -Infinity, null, null, null );

const getResource = async identifier => {
    const collection = await database.get( identifier.type );

    if ( undefined === collection ) {
        return uninitialized;
    }

    const item = await collection.get( identifier.id );

    return undefined !== item
        ? item
        : uninitialized;
}

export const performing = resources => Component => class extends React.Component {
    componentWillMount() {
        this.context.store.subscribe( this.update );

        this.performers = new Database()
        this.update()
    }

    componentDidUpdate() {
        this.update()
    }

    update = () => {
        const updates = {};
        const { request, perform } = resources( this.context.store.getState(), this.props )

        Object.keys( request ).forEach( key => {
            const resource = request[ key ]

            const prev = this.state[ key ]
            const next = getResource( resource )

            if ( prev !== next ) {
                updates[ key ] = next
            }
        } );

        Object.keys( perform ).forEach( key => {
            const [ next, performer ] = perform[ key ]
            const prev = this.performers.get( key )

            if ( prev !== next ) {
                this.performers.set( key, next )
                updates[ key ] = ( ...args ) => {
                    performer( ...args )
                        .initiator
                        .forEach( 
                            activity => Array.isArray( activity )
                                ? update( activity[ 0 ], activity[ 1 ] )
                                : this.context.store.dispatch( activity )
                        )
                }
            }
        } );

        this.setState( updates )
    }

    render() {
        const { requests } = resources

        Object.keys( requests ).forEach( key => {
            const request = requests[ key ]
            const { id, options: { freshness } } = request
            const prev = getResource( id )

            const staleness = Date.now() - prev.lastUpdated
            if ( staleness < freshness || requesting.has( id ) ) {
                return;
            }

            queueUpdate( request ) 
        } )

        return React.createElement( Component, { ...this.props, ...this.state }, this.props.Children );
    }
}

class DataType {
    constructor( { id, initiator, onSuccess, onFailure, onProgress, options } ) {
        this.id = id;
        this.initiator = initiator;
        this.onSuccess = onSuccess;
        this.onFailure = onFailure;
        this.onPartial = onPartial;
        this.options = options;
    }

    fresherThan( freshness ) {
        return new DataType( {
            id: this.id,
            initiator: this.initiator,
            onSuccess: this.onSuccess,
            onFailure: this.onFailure,
            onPartial: this.onPartial,
            options: { ...this.options, freshness }
        } )
    }
}

const postLike = ( siteId, postId, intent = 'likeIt' ) => new DataType(
    {
        id: ids.postLikes( siteId, postId ),
        initiator: [
            [ 
                ids.postLikes( siteId, postId ),
                intent === 'likeIt'
            ],
            { 
                type: 'WPCOM_HTTP_REQUEST', 
                method: 'POST', 
                apiVersion: '1.1', 
                path: `/sites/${ siteId }/posts/${ postId }/likes/new`
            }
        ],
        onSuccess: data => [
            [ 
                ids.postLikes( siteId, postId ), 
                !! data.i_like 
            ],
            [ 
                ids.postLikeCounts( siteId, postId ), 
                count => count + ( data.i_like === 'likeIt' ? 1 : -1 ) 
            ],
        ]
    }
)

const readerTags = () => new DataType( 
    {
        id: ids.readerTags(),
        intiator: [
            {
                type: 'WPCOM_HTTP_REQUEST',
                method: 'GET',
                apiVersion: '1',
                path: '/reader/tags'
            }
        ],
        onSuccess: data => [ ids.readerTags(), data.tags ],
        options: {
            freshness: 'satisfy'
        }
    }
)

const resourceMap = ( state, { siteId, postId } ) => ( {
    request: {
        isLiked: types.postLikes( siteId, postId ).fresherThan( 5 * SECOND_IN_MS ),
        posts: types.sitePosts( siteId ),
        tags: types.readerTags(),
    },
    perform: {
        setTitle: [
            ids.post( siteId, postId ),
            title => types.setPostTitle( siteId, postId, title )
        ]
    }
} )

const enhancer = store => next => action => {
    const shouldManage = action.type === '@tasks/RUN'
    if ( ! shouldManage ) {
        return next( action )
    }

    switch ( action.state ) {
        case 'partial':
            database.set( action.id, prev.update( action.payload ) );
            break;

        case 'success':
            types
                .get( action.id )
                .onSuccess( action.payload )
                .forEach(
                    response => Array.isArray( response )
                        ? database.set( response[ 0 ], database.get( response[ 0 ] ).succeed( response[ 1 ] ) )
                        : store.dispatch( response )
                )
            break;

        case 'failure':
            types
                .get( action.id )
                .onFailure( action.payload )
                .forEach(
                    response => Array.isArray( response )
                        ? database.set( response[ 0 ], database.get( response[ 0 ] ).fail( response[ 1 ] ) )
                        : store.dispatch( response )
                )
            break;
    }
}