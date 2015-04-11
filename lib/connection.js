'use strict';
var tarantoolConstants = require('./const');
var net = require('net');
var _ = require('underscore');
var EventEmitter = require('events');
var msgpack = require('msgpack');
var vow = require('vow');
var crypto = require('crypto');
var xor = require('bitwise-xor');

var shatransform = function(t){
    return crypto.createHash('sha1').update(t).digest();
};

var states = {
    CONNECTING: 0,
    CONNECTED: 1,
    AWAITING: 2,
    REQUESTING: 3,
    GETTING: 4,
    INITED: 5,
    DISONECTED: 6,
    PREHELLO: 7,
    AWAITING_LENGTH: 8
};

var commandType = {
    CONNECT: 0,
    REQUEST: 1
};

var requestId = {
    _id: 0,
    getId: function(){
        if (this._id > 1000000)
            this._id = 0;
        return this._id++;
    }
};

var defaultOptions = {
    host: 'localhost',
    port: '3301',
    username: null,
    password: null,
    timeout: 5000,
    reconnect: true
};


function TarantoolConnection (options){
    this.socket = new net.Socket({
        readable: true,
        writable: true
    });
    this.state = states.INITED;
    this.emitter = new EventEmitter();
    this.options = _.extend(defaultOptions, options);
    this.commandsQueue = [];
    this.socket.on('connect', this.onConnect.bind(this));
    this.socket.on('error', this.onError.bind(this));
    this.socket.on('data', this.onData.bind(this));
    this.responseEnded = true;
}

TarantoolConnection.prototype.onData = function(data){
    switch(this.state){
        case states.PREHELLO:
            for (var i = 0; i<this.commandsQueue.length; i++)
            {
                if (this.commandsQueue[i][0] == commandType.CONNECT)
                {
                    this.commandsQueue[i][1](true);
                    this.commandsQueue.splice(i, 1);
                    i--;
                }
            }
            this.salt = data.slice(64, 108).toString('utf8');
            this.state = states.CONNECTED;
            break;
        case states.CONNECTED:
            var trackResult = this._responseBufferTrack(data);
            if (trackResult.length == 2)
            {
                this.state = states.AWAITING;
                this.awaitingResponseLength = trackResult[1];
                this.buffer = trackResult[0];
            }
            else
            {
                this.buffer = null;
                this.state = states.CONNECTED;
            }
            break;
        case states.AWAITING:
            var trackResult = this._responseBufferTrack(Buffer.concat(this.buffer, data), this.awaitingResponseLength);
            if (trackResult.length == 2)
            {
                this.state = states.AWAITING;
                this.awaitingResponseLength = trackResult[1];
                this.buffer = trackResult[0];
            }
            else
            {
                this.buffer = null;
                this.state = states.CONNECTED;
            }
            break;
    }
};

TarantoolConnection.prototype._responseBufferTrack = function(buffer, length){
    if (!length)
    {
        if (buffer.length >= 5)
        {
            length = buffer.readUIntBE(1, 4);
            buffer = buffer.slice(5);
        }
        else
            return [buffer, null];
    }
    if (buffer.length >= length)
    {
        if (buffer.length == length)
        {
            this._processResponse(buffer);
            return [];
        }
        else
        {
            var curBuffer = buffer.slice(0, length);
            this._processResponse(curBuffer);
            return this._responseBufferTrack(buffer.slice(length));
        }
    }
    else
        return [buffer, length];
};

TarantoolConnection.prototype._processResponse = function(buffer){
    // add fixarraymap with 2 objects before main object
    var dataBuffer = Buffer.concat([new Buffer([0x92]), buffer]);
    var obj = msgpack.unpack(dataBuffer);
    var reqId = obj[0][1];
    var task = this.commandsQueue.filter(function(t){
        return t[1] == reqId;
    })[0];
    var dfd = task[2];
    var success = obj[0][0] == 0 ? true : false;
    if (success)
        dfd.resolve(this._processResponseBody(task[0], obj[1][tarantoolConstants.KeysCode.data]));
    else
        dfd.reject(obj[1][tarantoolConstants.KeysCode.error]);
};

TarantoolConnection.prototype._processResponseBody = function(cmd, data){
    return cmd == tarantoolConstants.RequestCode.rqAuth ? true : data;
};

TarantoolConnection.prototype._dropAll = function(){

};

TarantoolConnection.prototype.onConnect = function(){
    this.state = states.PREHELLO;
};

TarantoolConnection.prototype.onError = function(error){
    for (var i=0; i<this.commandsQueue.length; i++)
        this.commandsQueue[i][2](error);
    this.commandsQueue = [];
};

TarantoolConnection.prototype.connect = function(){
    this.state = states.CONNECTING;
    return new Promise(function(resolve, reject){
        this.commandsQueue.push([commandType.CONNECT, resolve, reject]);
        this.socket.connect({port: this.options.port, host: this.options.host});
    }.bind(this));
};

TarantoolConnection.prototype.ping = function(){
    var dfd = vow.defer();
    var reqId = requestId.getId();
    var header = this._header(tarantoolConstants.RequestCode.rqPing, reqId);
    var body = new Buffer(0);
    this._request(header, body);
    this.commandsQueue.push([tarantoolConstants.RequestCode.rqPing, reqId, dfd]);
    return dfd.promise();
};

TarantoolConnection.prototype.select = function(spaceId, indexId, limit, offset, iterator, key){
    var dfd = vow.defer();
    var reqId = requestId.getId();
    var header = this._header(tarantoolConstants.RequestCode.rqSelect, reqId);
    var buffered = {
        spaceId: msgpack.pack(spaceId),
        indexId: msgpack.pack(indexId),
        limit: msgpack.pack(limit),
        offset: msgpack.pack(offset),
        key: msgpack.pack(key)
    };
    var body = Buffer.concat([new Buffer([0x86,tarantoolConstants.KeysCode.space_id]), buffered.spaceId,
        new Buffer([tarantoolConstants.KeysCode.index_id]), buffered.indexId,
        new Buffer([tarantoolConstants.KeysCode.limit]), buffered.limit,
        new Buffer([tarantoolConstants.KeysCode.offset]), buffered.offset,
        new Buffer([tarantoolConstants.KeysCode.iterator, tarantoolConstants.IteratorsType[iterator],
            tarantoolConstants.KeysCode.key]),
        buffered.key
        ]);
    this._request(header, body);
    this.commandsQueue.push([tarantoolConstants.RequestCode.rqSelect, reqId, dfd]);
    return dfd.promise();
};

TarantoolConnection.prototype.delete = function(spaceId, indexId, key, limit){
    var dfd = vow.defer();
    var reqId = requestId.getId();
    var header = this._header(tarantoolConstants.RequestCode.rqDelete, reqId);
    var buffered = {
        spaceId: msgpack.pack(spaceId),
        indexId: msgpack.pack(indexId),
        key: msgpack.pack(key)
    };
    var body = Buffer.concat([new Buffer([0x86,tarantoolConstants.KeysCode.space_id]), buffered.spaceId,
        new Buffer([tarantoolConstants.KeysCode.index_id]), buffered.indexId,
        new Buffer([tarantoolConstants.KeysCode.key]), buffered.key]);
    this._request(header, body);
    this.commandsQueue.push([tarantoolConstants.RequestCode.rqSelect, reqId, dfd]);
    return dfd.promise();
};

TarantoolConnection.prototype.update = function(spaceId, indexId, key, ops){
    var dfd = vow.defer();
    if (Array.isArray(ops)){
        var reqId = requestId.getId();
        var header = this._header(tarantoolConstants.RequestCode.rqUpdate, reqId);
        var buffered = {
            spaceId: msgpack.pack(spaceId),
            indexId: msgpack.pack(indexId),
            ops: msgpack.pack(ops),
            key: msgpack.pack(key)
        };
        var body = Buffer.concat([new Buffer([0x84,tarantoolConstants.KeysCode.space_id]), buffered.spaceId,
            new Buffer([tarantoolConstants.KeysCode.index_id]), buffered.indexId,
            new Buffer([tarantoolConstants.KeysCode.key]), buffered.key,
            new Buffer([tarantoolConstants.KeysCode.tuple]), buffered.ops]);
        this._request(header, body);
        this.commandsQueue.push([tarantoolConstants.RequestCode.rqUpdate, reqId, dfd]);
    }
    else
        dfd.reject(new Error('need array'));
    return dfd.promise();
};

TarantoolConnection.prototype.eval = function(expression, tuple){
    var dfd = vow.defer();
    var reqId = requestId.getId();
    var header = this._header(tarantoolConstants.RequestCode.rqEval, reqId);
    var buffered = {
        expression: msgpack.pack(expression),
        tuple: msgpack.pack(tuple)
    };
    var body = Buffer.concat([new Buffer([0x82,tarantoolConstants.KeysCode.expression]), buffered.expression,
        new Buffer([tarantoolConstants.KeysCode.tuple]), buffered.tuple]);
    this._request(header, body);
    this.commandsQueue.push([tarantoolConstants.RequestCode.rqEval, reqId, dfd]);
    return dfd.promise();
};


TarantoolConnection.prototype.call = function(functionName, tuple){
    var dfd = vow.defer();
    var reqId = requestId.getId();
    var header = this._header(tarantoolConstants.RequestCode.rqCall, reqId);
    var buffered = {
        functionName: msgpack.pack(functionName),
        tuple: msgpack.pack(tuple)
    };
    var body = Buffer.concat([new Buffer([0x82,tarantoolConstants.KeysCode.function_name]), buffered.functionName,
        new Buffer([tarantoolConstants.KeysCode.tuple]), buffered.tuple]);
    this._request(header, body);
    this.commandsQueue.push([tarantoolConstants.RequestCode.rqCall, reqId, dfd]);
    return dfd.promise();
};


TarantoolConnection.prototype.insert = function(spaceId, tuple){
    var reqId = requestId.getId();
    return this._replaceInsert(tarantoolConstants.RequestCode.rqInsert, reqId, spaceId, tuple);
};

TarantoolConnection.prototype.replace = function(spaceId, tuple){
    var reqId = requestId.getId();
    return this._replaceInsert(tarantoolConstants.RequestCode.rqReplace, reqId, spaceId, tuple);
};

TarantoolConnection.prototype._replaceInsert = function(cmd, reqId, spaceId, tuple){
    var dfd = vow.defer();
    if (Array.isArray(tuple)){
        var header = this._header(cmd, reqId);
        var buffered = {
            spaceId: msgpack.pack(spaceId),
            tuple: msgpack.pack(tuple)
        };
        var body = Buffer.concat([new Buffer([0x82,tarantoolConstants.KeysCode.space_id]), buffered.spaceId,
            new Buffer([tarantoolConstants.KeysCode.tuple]), buffered.tuple]);
        this._request(header, body);
        this.commandsQueue.push([cmd, reqId, dfd]);
    }
    else
        dfd.reject(new Error('need array'));
    return dfd.promise();
};

TarantoolConnection.prototype.auth = function(username, password){
    var dfd = vow.defer();
    var reqId = requestId.getId();
    var header = this._header(tarantoolConstants.RequestCode.rqAuth, reqId);
    var buffered = {
        username: msgpack.pack(username)
    };
    var scrambled = scramble(password, this.salt);
    var body = Buffer.concat([new Buffer([0x82, tarantoolConstants.KeysCode.username]), buffered.username,
        new Buffer([0x21, 0x92]), tarantoolConstants.passEnter, new Buffer([0xb4]), scrambled]);
    this._request(header, body);
    this.commandsQueue.push([tarantoolConstants.RequestCode.rqAuth, reqId, dfd]);
    return dfd.promise();
};

function scramble(password, salt){
    var encSalt = new Buffer(salt, 'base64');
    var step1 = shatransform(password);
    var step2 = shatransform(step1);
    var step3 = shatransform(Buffer.concat([encSalt.slice(0, 20), step2]));
    var scramble = xor(step1, step3);
    return scramble;
}

TarantoolConnection.prototype._header = function(command, reqId){
    var header = new Buffer([0x82, tarantoolConstants.KeysCode.code, command,
        tarantoolConstants.KeysCode.sync, 0xce, 0, 0, 0, 0]);
    header.writeUIntBE(reqId, 5, 4);
    return header;
};

TarantoolConnection.prototype._request = function(header, body){
    var sumL = header.length + body.length;
    var prefixSizeBuffer = new Buffer(5);
    prefixSizeBuffer[0] = 0xCE;
    prefixSizeBuffer.writeUIntBE(sumL, 1, 4);
    var buffer = Buffer.concat([prefixSizeBuffer, header, body]);
    this.socket.write(buffer);
};

TarantoolConnection.prototype.destroy = function(interupt){
    if (interupt)
    {
        this.socket.destroy();
    }
    else
    {
        this.commandsQueue.push('destroy');
    }
};

module.exports = TarantoolConnection;