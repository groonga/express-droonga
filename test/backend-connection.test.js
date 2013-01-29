var assert = require('chai').assert;
var nodemock = require('nodemock');
var Deferred = require('jsdeferred').Deferred;

var utils = require('./test-utils');
var TypeOf = utils.TypeOf;
var InstanceOf = utils.InstanceOf;

var Connection = require('../lib/backend/connection').Connection;
var MsgPackReceiver = require('../lib/backend/receiver').MsgPackReceiver;

function createBackend() {
  var deferred = new Deferred();
  var backend = new MsgPackReceiver(utils.testSendPort);
  backend.received = [];
  backend.on('receive', function(data) {
    backend.received.push(data);
  });
  backend.listen(function() {
    return deferred.call(backend);
  });
  return deferred;
}

suite('Connection, initialization', function() {
  var connection;

  teardown(function() {
    if (connection) {
      connection.close();
      connection = undefined;
    }
  });

  function assertEventEmitter(object) {
    assert.equal(typeof object,
                 'object',
                 'should be an instance of EventEmitter');
    assert.equal(typeof object.emit,
                 'function',
                 'should be an instance of EventEmitter');
  }

  test('sender', function() {
    connection = new Connection({ tag: 'test' });
    assertEventEmitter(connection._sender);
  });

  test('receiver', function(done) {
    connection = new Connection({ tag: 'test' });
    assertEventEmitter(connection._receiver);
    assert.equal(connection.receivePort,
                 undefined,
                 'should be not-initialized');

    Deferred
      .wait(0.01)
      .next(function() {
        assert.notEqual(connection.receivePort,
                        undefined,
                        'should be initialized');
        done();
      })
      .error(function(error) {
        done(error);
      });
  });
});

suite('Connection, basic features', function() {
  var connection;
  var backend;

  setup(function(done) {
    createBackend()
      .next(function(newBackend) {
        backend = newBackend;
        connection = new Connection({
          tag:      'test',
          hostName: 'localhost',
          port:     utils.testSendPort,
          receivePort: utils.testReceivePort
        });
        done();
      });
  });

  teardown(function() {
    if (backend) {
      backend.close();
      backend = undefined;
    }
    if (connection) {
      connection.close();
      connection = undefined;
    }
  });

  function createExpectedEnvelope(type, body) {
    return {
      id:         TypeOf('string'),
      date:       InstanceOf(Date),
      replyTo:    'localhost:' + utils.testReceivePort,
      statusCode: 200,
      type:       type,
      body:       body
    };
  }

  function createReplyEnvelopeFor(message, type, body) {
    var now = new Date();
    var response = {
      id:         now.getTime(),
      date:       now.toISOString(),
      inReplyTo:  message.id,
      statusCode: 200,
      type:       type,
      body:       body
    };
    return response;
  }

  test('sending message without response (volatile message)', function(done) {
    var message;
    Deferred
      .wait(0.01)
      .next(function() {
        message = connection.emitMessage('testRequest', { command: 'foobar' });
        assert.envelopeEqual(message,
                             createExpectedEnvelope('testRequest',
                                                    { command: 'foobar' }));
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.deepEqual(backend.received[0][2], message);
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  function createMockedMessageCallback() {
    var mockedCallback = nodemock;
    var callback = function() {
      mockedCallback.receive.apply(mockedCallback, arguments);
    };
    callback.takes = function() {
      callback.assert = function() {
        mockedCallback.assertThrows();
      };
      mockedCallback = mockedCallback.mock('receive');
      mockedCallback = mockedCallback.takes.apply(mockedCallback, arguments);
    };
    callback.mock = mockedCallback;
    return callback;
  }

  test('receiving message from the backend', function(done) {
    var callback = createMockedMessageCallback();
    connection.on('message', callback);

    var now = new Date();
    var message = {
      id:         now.getTime(),
      date:       now.toISOString(),
      statusCode: 200,
      type:       'testResponse',
      body:       'first call'
    };
    callback.takes(message);
    var packet = { tag: 'test.message', data: message };
    utils.sendPacketTo(packet, utils.testReceivePort)
      .next(function() {
        callback.assert();

        message.body = 'second call';
        callback.takes(message);
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();

        message.body = 'third call';
        connection.removeListener('message', callback);
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  test('sending message with one response, success', function(done) {
    var callback = createMockedMessageCallback();
    var message;
    var response;
    var packet;
    Deferred
      .wait(0.01)
      .next(function() {
        message = connection.emitMessage('testRequest',
                                         { command: 'foobar' },
                                         callback);
        assert.envelopeEqual(message,
                             createExpectedEnvelope('testRequest',
                                                    { command: 'foobar' }));
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.deepEqual(backend.received[0][2], message);

        response = createReplyEnvelopeFor(message,
                                          'testResponse',
                                          'first call');
        callback.takes(null, response);
        packet = { tag: 'test.message', data: response };
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();

        // Secondary and later messages are ignored.
        response.body = 'second call';
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  test('sending message with one response, with error', function(done) {
    var callback = createMockedMessageCallback();
    var message;
    var response;
    var packet;
    Deferred
      .wait(0.01)
      .next(function() {
        message = connection.emitMessage('testRequest',
                                         { command: 'foobar' },
                                         callback);
        assert.envelopeEqual(message,
                             createExpectedEnvelope('testRequest',
                                                    { command: 'foobar' }));
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.deepEqual(backend.received[0][2], message);

        response = createReplyEnvelopeFor(message,
                                          'testResponse',
                                          'first call');
        response.statusCode = 503;
        callback.takes(503, response);
        packet = { tag: 'test.message', data: response };
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  test('sending message with one response, timeout (not timed out)', function(done) {
    var callback = createMockedMessageCallback();
    var message;
    var response;
    var packet;
    Deferred
      .wait(0.01)
      .next(function() {
        message = connection.emitMessage('testRequest',
                                         { command: 'foobar' },
                                         callback,
                                         { timeout: 1000 });
        assert.envelopeEqual(message,
                             createExpectedEnvelope('testRequest',
                                                    { command: 'foobar' }));
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.deepEqual(backend.received[0][2], message);
        assert.equal(connection.listeners('inReplyTo:' + message.id).length,
                     1,
                     'response listener should be still there');

        response = createReplyEnvelopeFor(message,
                                          'testResponse',
                                          'first call');
        callback.takes(null, response);
        packet = { tag: 'test.message', data: response };
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();
        assert.equal(connection.listeners('inReplyTo:' + message.id).length,
                     0,
                     'response listener should be removed');
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  test('sending message with one response, timeout (timed out)', function(done) {
    var callback = createMockedMessageCallback();
    var message;
    var response;
    Deferred
      .wait(0.01)
      .next(function() {
        callback.takes(Connection.ERROR_GATEWAY_TIMEOUT, null);
        message = connection.emitMessage('testRequest',
                                         { command: 'foobar' },
                                         callback,
                                         { timeout: 20 });
        assert.envelopeEqual(message,
                             createExpectedEnvelope('testRequest',
                                                    { command: 'foobar' }));
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.deepEqual(backend.received[0][2], message);
        assert.equal(connection.listeners('inReplyTo:' + message.id).length,
                     1,
                     'response listener should be still there');
      })
      .wait(0.02)
      .next(function() {
        assert.equal(connection.listeners('inReplyTo:' + message.id).length,
                     0,
                     'response listener should be removed by timeout');
        callback.assert();
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  test('sending message with one response, timeout (ignored negative timeout)', function() {
    var callback = createMockedMessageCallback();
    var message;
    var response;
    var packet;
    Deferred
      .wait(0.01)
      .next(function() {
        message = connection.emitMessage('testRequest',
                                         { command: 'foobar' },
                                         callback,
                                         { timeout: -1 });
        assert.envelopeEqual(message,
                             createExpectedEnvelope('testRequest',
                                                    { command: 'foobar' }));
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.deepEqual(backend.received[0][2], message);
        assert.equal(connection.listeners('inReplyTo:' + message.id).length,
                     1,
                     'response listener should be still there');

        response = createReplyEnvelopeFor(message, 'testResponse', 'first call');
        callback.takes(null, response);
        packet = { tag: 'test.message', data: response };
        return utils.sendPacketTo(packet, utils.testReceivePort);
      })
      .next(function() {
        callback.assert();
        assert.equal(connection.listeners('inReplyTo:' + message.id).length,
                     0),
                     'response listener should be removed';
        done();
      })
      .error(function(error) {
        done(error);
      });
  });
});

suite('Connection, to backend', function() {
  var connection;
  var backend;

  setup(function(done) {
    createBackend()
      .next(function(newBackend) {
        backend = newBackend;
        connection = new Connection({
          tag:      'test',
          hostName: 'localhost',
          port:     utils.testSendPort
        });
        done();
      });
  });

  teardown(function() {
    if (backend) {
      backend.close();
      backend = undefined;
    }
    if (connection) {
      connection.close();
      connection = undefined;
    }
  });

  test('normal messaging', function(done) {
    Deferred
      .wait(0.01)
      .next(function() {
        connection.emitMessage({ message: true });
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.equal(backend.received[0][0], 'test.message');
        done();
      })
      .error(function(error) {
        done(error);
      });
  });

  test('disconnected suddenly', function(done) {
    var restartedBackend;
    Deferred
      .wait(0.01)
      .next(function() {
        connection.emitMessage('test', { message: true });
      })
      .wait(0.01)
      .next(function() {
        assert.equal(backend.received.length, 1, 'message should be sent');
        assert.equal(backend.received[0][0], 'test.message');

        backend.close();
      })
      .wait(0.01)
      .next(function() {
        return createBackend();
      })
      .next(function(newBackend) {
        restartedBackend = newBackend;
        connection.emitMessage('test', { message: true });
      })
      .wait(0.5)
      .next(function() {
        assert.equal(restartedBackend.received.length,
                     1,
                     'message should be sent to the restarted backend');
        done();
      })
      .error(function(error) {
        done(error);
      });
  });
});
