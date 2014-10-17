var assert = require('chai').assert;
var nodemock = require('nodemock');

var utils = require('../test-utils');

var express = require('express');
var httpAdapter = require('../../lib/adapter/http');
var command = require('../../lib/adapter/command');
var api = require('../../lib/adapter/api');
var restAPI = require('../../lib/adapter/api/rest');
var droongaAPI = require('../../lib/adapter/api/droonga');
var groongaAPI = require('../../lib/adapter/api/groonga');

suite('HTTP Adapter', function() {
  test('registration of plugin commands', function() {
    var application = express();
    var registeredCommands = httpAdapter.register(application, {
      prefix:     '',
      connectionPool: utils.createStubbedBackendConnectionPool(),
      plugins: [
        api.API_REST,
        api.API_SOCKET_IO,
        api.API_GROONGA,
        api.API_DROONGA
      ]
    });

    registeredCommands = registeredCommands.map(function(command) {
      return {
        name:       command.name,
        definition: command.definition
      };
    });
    assert.deepEqual(registeredCommands,
                     [{ name:       'search',
                        definition: restAPI.search },
                      { name:       'groonga',
                        definition: groongaAPI.groonga },
                      { name:       'groonga-post',
                        definition: groongaAPI['groonga-post'] },
                      { name:       'droonga-get',
                        definition: droongaAPI['droonga-get'] },
                      { name:       'droonga-post',
                        definition: droongaAPI['droonga-post'] },
                      { name:       'droonga-streaming:watch',
                        definition: droongaAPI["droonga-streaming:watch"] }]);
  });

  suite('registration', function() {
    var testPlugin = {
      adapter: new command.HTTPRequestResponse({
        path: '/path/to/adapter',
        onRequest: function(request, connection) {
          connection.emit('adapter', 'adapter requested');
        },
        onResponse: function(data, response) {
          response.status(200).jsonp('adapter OK');
        }
      })
    };

    var connectionPool;
    var application;
    var server;

    setup(function(done) {
      connectionPool = utils.createStubbedBackendConnectionPool();
      utils.setupApplication({ connectionPool: connectionPool })
        .then(function(result) {
          server = result.server;
          application = result.application;
          done();
        })
        .catch(done);
    });

    teardown(function() {
      utils.teardownApplication({ server:     server,
                                  connectionPool: connectionPool });
    });

    test('to the document root', function(done) {
      httpAdapter.register(application, {
        prefix:     '',
        connectionPool: connectionPool,
        plugins:    [
          testPlugin
        ]
      });

      var responses = [];
      utils.get('/path/to/adapter')
        .then(function(response) { responses.push(response); })
        .then(function() {
          assert.deepEqual(
            connectionPool.emittedMessages,
            [
              [{ type: 'adapter', message: 'adapter requested' }]
            ]
          );
          assert.deepEqual(
            responses,
            [
              { statusCode: 200, body: JSON.stringify('adapter OK') }
            ]
          );
          done();
        })
        .catch(done);
    });

    test('under specified path', function(done) {
      httpAdapter.register(application, {
        prefix:     '/path/to/droonga',
        connectionPool: connectionPool,
        plugins:    [
          testPlugin
        ]
      });

      var responses = [];
      utils.get('/path/to/droonga/path/to/adapter')
        .then(function(response) { responses.push(response); })
        .then(function() {
          assert.deepEqual(
            connectionPool.emittedMessages,
            [
              [{ type: 'adapter', message: 'adapter requested' }]
            ]
          );
          assert.deepEqual(
            responses,
            [
              { statusCode: 200, body: JSON.stringify('adapter OK') }
            ]
          );
          done();
        })
        .catch(done);
    });
  });

  suite('default commands', function() {
    var server;

    teardown(function() {
      if (server) {
        server.close();
        server = undefined;
      }
    });

    test('search', function(done) {
      var receiverCallback = {};
      var connectionPool = utils.createStubbedBackendConnectionPool();
      var connection = connectionPool.get();
      var application = express();
      httpAdapter.register(application, {
        prefix:     '',
        connectionPool: connectionPool,
        plugins: [
          api.API_REST
        ]
      });
      utils.setupServer(application)
        .then(function(newServer) {
          server = newServer;
        })
        .then(utils.getCb('/tables/Store?query=NY'))
        .then(function() {
          assert.equal(1, connection.emitMessageCalledArguments.length);
          var args = connection.emitMessageCalledArguments[0];
          assert.equal(args.type, 'search');

          var expected = {
            queries: {
              stores: {
                source: 'Store',
                condition: {
                  query: 'NY'
                },
                output: {
                  elements: utils.allElements,
                  attributes: []
                }
              }
            }
          };
          assert.equalJSON(args.message, expected);

          done();
        })
        .catch(done);
    });

    test('droonga', function(done) {
      var receiverCallback = {};
      var connectionPool = utils.createStubbedBackendConnectionPool();
      var connection = connectionPool.get();
      var application = express();
      httpAdapter.register(application, {
        prefix:     '',
        connectionPool: connectionPool,
        plugins: [
          api.API_DROONGA
        ]
      });
      var searchQueries = {
        source: 'table',
        condition: { query: '検索', matchTo: ['body'] }
      };
      utils.setupServer(application)
        .then(function(newServer) {
          server = newServer;
        })
        .then(utils.postCb('/droonga/search', JSON.stringify({ queries: searchQueries })))
        .then(function() {
          assert.equal(1, connection.emitMessageCalledArguments.length);
          var args = connection.emitMessageCalledArguments[0];
          assert.equal(args.type, 'search');

          var expected = {
            queries: searchQueries,
            timeout: 1000,
            type:    'droonga-search'
          };
          assert.equalJSON(args.message, expected);

          done();
        })
        .catch(done);
    });
  });

  suite('multiple backends', function() {
    var testPlugin = {
      adapter: new command.HTTPRequestResponse({
        path: '/endpoint',
        onRequest: function(request, connection) {
          connection.emit('adapter', 'requested ' + request.query.id);
        },
        onResponse: function(data, response) {
          response.status(200).send(data);
        }
      })
    };

    var server;

    teardown(function() {
      if (server) {
        server.close();
        server = undefined;
      }
    });

    test('round-robin', function(done) {
      var receiverCallback = {};
      var connectionPool = utils.createStubbedBackendConnectionPool(3);
      var application = express();
      httpAdapter.register(application, {
        prefix:     '',
        connectionPool: connectionPool,
        plugins: [
          testPlugin
        ]
      });
      var responses = [];
      utils.setupServer(application)
        .then(function(newServer) {
          server = newServer;
        })
        .then(utils.getCb('/endpoint?id=1'))
          .then(function(response) { responses.push(response); })
        .then(utils.getCb('/endpoint?id=2'))
          .then(function(response) { responses.push(response); })
        .then(utils.getCb('/endpoint?id=3'))
          .then(function(response) { responses.push(response); })
        .then(utils.getCb('/endpoint?id=4'))
          .then(function(response) { responses.push(response); })
        .then(function() {
          assert.deepEqual(
            connectionPool.emittedMessages,
            [
              [{ type: 'adapter', message: 'requested 1' },
               { type: 'adapter', message: 'requested 4' }],
              [{ type: 'adapter', message: 'requested 2' }],
              [{ type: 'adapter', message: 'requested 3' }]
            ]
          );
          assert.deepEqual(
            responses,
            [
              { statusCode: 200, body: 'requested 1' },
              { statusCode: 200, body: 'requested 2' },
              { statusCode: 200, body: 'requested 3' },
              { statusCode: 200, body: 'requested 4' }
            ]
          );
          done();
        })
        .catch(done);
    });
  });
});

