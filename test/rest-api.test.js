var assert = require('chai').assert;
var nodemock = require('nodemock');

var utils = require('./test-utils');

var express = require('express');
var expressKotoumi = require('../lib/index');
var Connection = require('../lib/backend-adaptor').Connection;

suite('REST API', function() {
  var connection;
  var sender;
  var receiver;
  var server;

  function commonSetup() {
    connection = new Connection({
      tag:        'test',
      listenPort: utils.testServerPort,
      sender:     sender = utils.createMockedSender(),
      receiver:   receiver = utils.createMockedReceiver()
    });
    receiver.triggerConnect('test');
  }

  function commonTeardown() {
    if (server) {
      server.close();
    }
    connection = undefined;
    sender = undefined;
    receiver = undefined;
    server = undefined;
  }

  test('registeration for given handlers', function() {
    var mockedHandlers = nodemock.mock('search')
          .takes('fake connection')
          .returns(function() {});
    var application = express();
    application.kotoumi({
      prefix:     '',
      connection: 'fake connection',
      handlers:   mockedHandlers
    });
    mockedHandlers.assertThrows();
  });

  suite('registeration', function() {
    setup(commonSetup);
    teardown(commonTeardown);

    function createHandler(type) {
      return function(request, response) {
        response.write(type + 'OK');
      }
    }

    test('to the document root', function(done) {
      var application = express();
      application.kotoumi({
        prefix:     '',
        connection: connection,
        handlers:   {
          search: createHandler('search')
        }
      });
      server = utils.setupServer(application);

      utils
        .get('/tables/foobar')
        .next(function(response) {
          assert.equal('search OK', response.Body);
          done();
        })
        .error(function(error) {
          done(error);
        });
    });
  });
});

