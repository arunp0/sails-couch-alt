/*
 *  The Query interface for the adapter
 *
 */
var helper = require('./helper');
var _ = require('lodash');

var knownViews = []; //TODO: cache for knownViews saves a check roundtrip

//bypass the Logging
var logger = 'undefined' !== typeof sails ? sails.log : console;
if (!logger.debug)
	logger.debug = console.info;

module.exports = {
	findbyId: function(db, type, id, opts, cb) {
		if (!id) { //no id was passed?
			logger.warn('No id was passed to findbyId, are you sure this is what you wanted?');
			return cb(null, []); //returning an empty array instead of an error
		}
		if (Array.isArray(id)) { //a bunch of ids passed, do a bulk fetch
			var fixedIds = id.map(function(i) {
				return i.indexOf('/') > -1 ? i : type + '/' + i;
			}); //fix the ids
			var ids = {
				keys: fixedIds
			};
			db.fetch(ids, opts, function(err, body) {
				if (err && err.statusCode != 404)
					return cb(err);
				return cb(null, body.rows);
			});
		} else {
			id = id.indexOf('/') > -1 ? id : type + '/' + id; // if id is an absolute id
			db.get(id, opts, function(err, doc) {
				if (err && err.statusCode != 404)
					return cb(err);
				var docs = doc ? [doc] : [];
				return cb(null, docs);
			});
		}
	},
	/* ensure a view and and map before calling find */
	ensureView: function(db, type, opts, cb) {
		var key = '_design/' + type;
		var viewName = opts._view || helper.getViewName(opts.where.like || opts.where);
		db.get(key, function(err, existing) { //get design doc
			if (err && err['statusCode'] != 404) // any other error than not found, return
				return cb(err);
			//Explicit view request but the view does not exist in couch.
			if (err && err['statusCode'] === 404 && opts._view)
				return cb(new Error('Queried _view does not exist', opts._view));
			if (existing && existing.views && existing.views[viewName]) //we have the view
				return cb();
			//If you are here, the view does not exist,
			//first build the map function, then the view
			// and finally create it
			var viewObj = helper.buildView(viewName, helper.createViewMap(opts.where, opts.type));

			return helper.createView(db, viewObj, type, cb);
		});
	},
	buildLikeKeys: function(where) {
		var startKey = [];
		var endKey = [];
		Object.keys(where.like).forEach(function(key) {
			var value = where.like[key];
			if ('string' != typeof value) throw new Error('like value must be a string');
			if (value.charAt(value.length - 1) == '%') value = value.substring(0, value.length - 1);
			startKey.push(value);
			endKey.push(value + '\ufff0');
		});

		return {
			startkey: startKey,
			endkey: endKey
		};
	},
	buildKeys: function(opts, cb) {
		if (opts.where.like)
			return cb(null, module.exports.buildLikeKeys(opts.where));
		//not a like query, just return an array of key values
		return cb(null, Object.keys(opts.where).map(function(key) {
			var val = opts.where[key];
			if ('object' == typeof val) { //an object was passed as key, probably a model
				return _.has(val, 'id') ? val.id : val; //keys can be objects, particularly arrays
			}
			return val;
		}));
	},

	findbyView: function(db, type, opts, cb) {
		module.exports.ensureView(db, type, opts, function(err) {
			if (err)
				return cb(err);
			//at this point our view should exist, so build the keys and query it
			module.exports.buildKeys(opts, function(err, value) {
				var viewName = opts._view || helper.getViewName(opts.where.like || opts.where);
				if (opts.where.like) {
					opts.startkey = value.startkey;
					opts.endkey = value.endkey;
				} else {
					//if value has a null, then partialKeys were provided, handle accordingly.
					var partial = _.some(value, null); //return true if any element in value is null
					if (partial) {
						opts.startkey = _.filter(value, function(val) {
							return val !== null;
						}); //remove the null element for startkey
						opts.endkey = value.map(function(val) {
							return val === null ? {} : val;
						}); //replace null with {}
					} else {
						opts.keys = value;
					}
				}
				//delete the where object from opts before calling view
				delete opts.where;
				delete opts._view;
				delete opts._partial;
				db.view(type, viewName, opts, function(err, body) {
					if (err) {
						return cb(err);
					}
					cb(null, body.rows);
				});
			});
		});
	},
	/* Global entry point to find function
	   options: {
	      skip, limit, where, sort: { createdAt: -1 }
	 }
	 */
	find: function(db, type, options, cb) {
		//find returns keys, values (id in most cases) and docs.
		//this just extracts the doc.
		var extractDoc = function(docs) {
			return docs.map(function(d) {
				return d.doc ? d.doc : d; //in findbyId, all you get is a doc and not a resultset
			});
		};
		var opts = {};
		if (options && options.limit)
			opts.limit = options.limit;
		if (options && options.skip)
			opts.skip = options.skip;
		if (options && options.sort)
			opts.sort = options.sort;

		opts.include_docs = true; //by default we include documents
    opts.reduce = false; //by default we don't use reduce
		opts.type = type; //useful for building view filter


		var whereKeys = Object.keys((options && options.where) || {});

		if (whereKeys.length === 0) { //no keys to where, get all docs
			return module.exports.fetchAll(db, type, opts, function(err, rows) {
				if (err)
					return cb(err);
				return cb(null, extractDoc(rows));
			});
		}
		if (whereKeys.length == 1 &&
			(whereKeys[0] == 'id' || whereKeys[0] == '_id')) { //single key, the id
			var id = options.where.id || options.where._id;
			return module.exports.findbyId(db, type, id, opts, function(err, rows) {
				if (err)
					return cb(err);
				return cb(null, extractDoc(rows));
			});
		}

		//Support for querying by existing views
		if (options.where && options.where._view) {
			opts._view = options.where._view;
			delete options.where._view;
		}

    if (options.where && options.where._include_docs) {
      if(options.where._include_docs === false){
        opts.include_docs = options.where._include_docs;
      }
      delete options.where._include_docs;
    }
		//include doc_type = type in the list of whereKeys, to filter unwanted
		opts.where = options.where;
		//opts.where.doc_type = type;
		return module.exports.findbyView(db, type, opts, function(err, rows) {
			if (err)
				return cb(err);
			return cb(null, extractDoc(rows));
		});
	},
	fetchAll: function(db, type, opts, cb) {
		opts = opts || {};
		opts.key = type;
		db.view('metadata', 'by_type', opts, function(err, body) {
			if (err)
				return cb(err);
			cb(null, body.rows);
		});
	}
};
