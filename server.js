var settings = require('./settings');
var msgs = settings.msgs;
var dao = require('./dao');

var _ = require('underscore');
var $ = require('jquery-deferred');
var express = require('express');
var app = express();
var fs = require('fs');
var http = require('http');
var httpPort = settings.server.port;
var server;
var verifyEnabled = !!settings.emailServer;

if (settings.https) {
    var httpsPort = settings.https.port;
    var happ = express();
    var hserver = http.Server(happ);
    happ.get('*', function(req, res) {
        res.redirect('https://' + /^([^:]+)(?::\d+|)$/.exec(req.get('host'))[1] + (httpsPort == 443 ? '' : ':' + httpsPort) + req.url);
    });
    hserver.listen(httpPort, function() {
        console.log('http (for redirecting) listening on *:' + httpPort);
    });
    server = require('https').createServer({
        key : fs.readFileSync(settings.https.key),
        cert : fs.readFileSync(settings.https.cert)
    }, app);
    server.listen(httpsPort, function() {
        console.log('https listening on *:' + httpsPort);
    });
} else {
    server = http.Server(app);
    server.listen(httpPort, function() {
        console.log('http listening on *:' + httpPort);
    });
}

var io = require('socket.io')(server);

if (settings.server.compression) {
    app.use(require('compression')());
}

app.use(express.static(__dirname + '/static', settings.server.cache ? {
    maxAge : settings.server.cache
} : undefined));

var channels = {};

function getClientIp(socket) {
    return socket.request.connection.remoteAddress;
}

function start(channelName) {
    console.log('Starting channel: ' + (channelName || '<fontpage>'));

    var room = io.of('/' + channelName);
    var channel = channels[channelName] = {
        online : []
    };

    room.on('connection', function(socket) {
        var user = {
            remote_addr : getClientIp(socket),
            socket : socket
        };

        var log = {};
        [ 'error', 'info', 'debug' ].forEach(function(lvl) {
            log[lvl] = function() {
                if (settings.log[lvl]) {
                    var prefix = lvl.toUpperCase() + ' [' + user.remote_addr;
                    if (user.nick) {
                        prefix += ',' + user.nick;
                    }
                    prefix += ']';
                    var args = _.toArray(arguments);
                    args.splice(0, 0, prefix);
                    console[lvl == 'error' ? 'error' : 'log'].apply(console, args);
                }
            };
        });

        log.info('New connection');

        socket.on('disconnect', function() {
            if (user.nick) {
                var i = indexOf(user.nick);
                if (i >= 0) {
                    channel.online.splice(i, 1);
                } else {
                    log.info('Disconnected user was not found');
                }
                roomEmit('left', {
                    id : user.socket.id,
                    nick : user.nick
                });
            }
            log.info('Disconnected');
        });

        // -----------------------------------------------------------------------------
        // COMMANDS
        // -----------------------------------------------------------------------------

        var COMMANDS = {
            nick : {
                params : [ 'nick' ],
                handler : function(dao, dbuser, params) {
                    return attemptNick(dao, params.nick.substring(0, settings.limits.nick));
                }
            },
            me : {
                params : [ 'message' ],
                handler : function(dao, dbuser, params) {
                    var message = params.message.substring(0, settings.limits.message)
                    roomEmit('message', {
                        type : 'action-message',
                        message : user.nick + ' ' + params.message
                    });
                    return $.Deferred().resolve(true).promise();
                }
            },
            login : {
                params : [ 'nick', 'password' ],
                handler : function(dao, dbuser, params) {
                    var done = $.Deferred();
                    var nick = params.nick.substring(0, settings.limits.nick);
                    dao.findUser(nick).then(function(u) {
                        if (u && u.get('verified')) {
                            attemptNick(dao, nick, params.password).then(function() {
                                done.resolve.apply(done, arguments);
                            }, function(err) {
                                done.reject(err);
                            });
                        } else {
                            done.resolve(false, msgs.nickNotVerified);
                        }
                    }, function(err) {
                        done.reject(err);
                    });
                    return done.promise();
                }
            },
            unregister : {
                handler : function(dao, dbuser, params) {
                    return dbuser.unregister();
                }
            },
            register : {
                params : verifyEnabled ? [ 'email_address' ] : [ 'email_address', 'initial_password' ],
                handler : function(dao, dbuser, params) {
                    return dbuser.register(params.email_address, params.initial_password);
                }
            },
            verify : {
                params : [ 'verification_code', 'initial_password' ],
                handler : function(dao, dbuser, params) {
                    return dbuser.verify(params.verification_code, params.initial_password).done(function() {
                        socketEmit('update', {
                            password : params.initial_password
                        });
                    });
                }
            },
            banlist : {
                access_level : 1,
                handler : function(dao, dbuser, params) {
                    return dao.banlist().then(function(list) {
                        if (list && list.length > 0) {
                            showMessage(msgs.get('banlist', list.join(', ')));
                        } else {
                            showMessage(msgs.no_banned_global);
                        }
                        return true;
                    });
                }
            },
            channel_banlist : {
                access_level : 1,
                handler : function(dao, dbuser, params) {
                    return dao.banlist(channelName).done(function(list) {
                        if (list && list.length > 0) {
                            showMessage(msgs.get('channel_banlist', list.join(', ')));
                        } else {
                            showMessage(msgs.no_banned_channel);
                        }
                        return true;
                    });
                }
            },
            ban : {
                access_level : 1,
                params : [ 'id' ],
                handler : function(dao, dbuser, params) {
                    return dao.ban(params.id);
                }
            },
            unban : {
                access_level : 1,
                params : [ 'id' ],
                handler : function(dao, dbuser, params) {
                    return dao.unban(params.id);
                }
            },
            channel_ban : {
                access_level : 1,
                params : [ 'id' ],
                handler : function(dao, dbuser, params) {
                    return dao.ban(params.id, channelName);
                }
            },
            channel_unban : {
                access_level : 1,
                params : [ 'id' ],
                handler : function(dao, dbuser, params) {
                    return dao.unban(params.id, channelName);
                }
            },
            access : {
                access_level : 0,
                params : [ 'nick', 'access_level' ],
                handler : function(dao, dbuser, params) {
                    var done = $.Deferred();
                    dao.findUser(params.nick).then(function(dbuser) {
                        if (dbuser) {
                            dbuser.access(params.access_level).done(handleResponse);
                            done.resolve(true);
                        } else {
                            done.resolve(false, msgs.get('user_doesnt_exist', params.nick));
                        }
                    }, function(err) {
                        done.reject(err);
                    });
                    return done.promise();
                }
            },
            whoami : {
                handler : function(dao, dbuser) {
                    showMessage(msgs.get('whoami', dbuser.get('nick'), dbuser.get('access_level'), user.remote_addr));
                    return $.Deferred().resolve(true).promise();
                }
            },
            whois : {
                access_level : 0,
                params : [ 'nick' ],
                handler : function(dao, dbuser, params) {
                    var done = $.Deferred();
                    dao.findUser(params.nick).done(function(dbuser) {
                        if (dbuser) {
                            showMessage(msgs.get('whois', dbuser.get('nick'), dbuser.get('access_level'), dbuser.get('remote_addr')));
                            done.resolve(true);
                        } else {
                            done.resolve(false, msgs.get('user_doesnt_exist', params.nick));
                        }
                    }, function(err) {
                        done.reject(err);
                    });
                    return done.promise();
                }
            },
            find_ip : {
                access_level : 0,
                params : [ 'remote_addr' ],
                handler : function(dao, dbuser, params) {
                    return dao.find_ip(params.remote_addr).then(function(nicks) {
                        if (nicks.length > 0) {
                            showMessage(msgs.get('find_ip', params.remote_addr, nicks.join(', ')));
                        } else {
                            showMessage(msgs.get('find_ip_empty', params.remote_addr));
                        }
                        return true;
                    });
                }
            },
            topic : {
                access_level : 0,
                params : [ 'topic' ],
                handler : function(dao, dbuser, params) {
                    var topic = params.topic.substring(0, settings.limits.message)
                    return dao.setChannelInfo(channelName, 'topic', params.topic).then(function() {
                        roomEmit('update', {
                            topic : params.topic
                        });
                        return true;
                    });
                }
            },
            pm : {
                params : [ 'nick', 'message' ],
                handler : function(dao, dbuser, params) {
                    var done = $.Deferred();
                    var to = indexOf(params.nick);
                    if (to >= 0) {
                        var toSocket = channel.online[to].socket;
                        var message = {
                            type : 'personal-message',
                            from : user.nick,
                            to : params.nick,
                            message : params.message.substring(0, settings.limits.message)
                        };
                        socketEmit(socket, 'message', message);
                        toSocket != socket && socketEmit(toSocket, 'message', message);
                        done.resolve(true);
                    } else {
                        done.resolve(false, msgs.pmOffline);
                    }
                    return done.promise();
                }
            }
        };

        // -----------------------------------------------------------------------------
        // MESSAGES
        // -----------------------------------------------------------------------------

        _.each({
            join : function(dao, msg) {
                if (!user.nick) {
                    var nick = msg && msg.nick;
                    var pwd = msg && msg.password;
                    if (nick) {
                        var done = $.Deferred();
                        dao.isBanned(channelName, nick, user.remote_addr).then(function(isbanned) {
                            if (isbanned) {
                                log.debug('Join request, but user is banned');
                                errorMessage(msgs.banned);
                                socket.disconnect();
                            } else {
                                attemptNick(dao, nick, pwd).then(function() {
                                    done.resolve.apply(done, arguments);
                                }, function(err) {
                                    done.reject(err);
                                });
                            }
                        });
                        return done.promise();
                    } else {
                        return attemptNick(dao);
                    }
                } else {
                    log.debug('Join request, but user already online');
                    return $.Deferred().resolve(false).promise();
                }
            },
            message : function(dao, msg) {
                var done = $.Deferred();
                if (user.nick) {
                    if (typeof msg == 'string') {
                        roomEmit('message', {
                            nick : user.nick,
                            type : 'chat-message',
                            message : msg.substring(0, settings.limits.message)
                        });
                        done.resolve(true);
                    } else {
                        log.debug('Invalid message');
                        done.resolve(false);
                    }
                } else {
                    log.debug('User is not online');
                    done.resolve(false);
                }
                return done.promise();
            },
            command : function(dao, msg) {
                var done = $.Deferred();
                if (user.nick) {
                    var cmd = COMMANDS[msg && msg.name];
                    if (cmd) {
                        var params = msg.params;
                        var valid = true;
                        if (cmd.params) {
                            valid = !_.any(cmd.params, function(param) {
                                return typeof params[param] != 'string' || !params[param];
                            });
                        }
                        if (valid) {
                            dao.findUser(user.nick).done(function(dbuser) {
                                if (typeof cmd.access_level == 'number') {
                                    valid = cmd.access_level >= dbuser.get('access_level');
                                }
                                if (valid) {
                                    cmd.handler(dao, dbuser, params).then(function(success, msg) {
                                        done.resolve(success, msg);
                                    }, function(err) {
                                        done.reject(err);
                                    });
                                } else {
                                    done.resolve(false, msgs.invalidCommandAccess);
                                }
                            });
                        } else {
                            done.resolve(false, msgs.invalidCommandParams);
                        }
                    } else {
                        done.resolve(false, msgs.invalidCommand);
                    }
                } else {
                    log.debug('User is not online');
                    done.resolve(false);
                }
                return done.promise();
            }
        },

        /*
         * For each message wrap in a function which will check if the user is
         * banned or not.
         */
        function(fn, msg) {
            socket.on(msg, function() {
                var args = _.toArray(arguments);
                log.debug('Received message: ', msg, args);
                dao(function(dao) {
                    dao.isBanned(channelName, user.remote_addr, user.nick).done(function(banned) {
                        log.debug('User is ' + (banned ? '' : 'not ') + 'banned');
                        if (banned) {
                            errorMessage(msgs.banned);
                            socket.disconnect();
                            dao.release();
                        } else {
                            args.splice(0, 0, dao);
                            fn.apply(null, args).done(handleResponse).always(function() {
                                dao.release();
                            });
                        }
                    });
                });
            });
        });

        // -----------------------------------------------------------------------------
        // INNER FUNCTIONS
        // -----------------------------------------------------------------------------

        /**
         * @inner
         * @param {Object} dao
         * @return {$.Promise<boolean>}
         */
        function initClient(dao) {
            var done = $.Deferred();
            dao.isBanned(channelName, user.remote_addr).then(function(banned) {
                if (banned) {
                    errorMessage(msgs.banned);
                    socket.disconnect();
                    done.resolve(false);
                } else {
                    var users = _.map(channel.online, function(user) {
                        return {
                            id : user.socket.id,
                            nick : user.nick
                        };
                    });
                    socketEmit(socket, 'online', users);
                    dao.getChannelInfo(channelName).then(function(channelInfo) {
                        socketEmit(socket, 'update', channelInfo);
                        done.resolve(true);
                    }, function(err) {
                        done.reject(err);
                    });
                }
            }, function(err) {
                done.reject(err);
            });
            return done.promise();
        }

        /**
         * @inner
         * @param {Socket} socket
         */
        function socketEmit(socket) {
            var args = _.toArray(arguments);
            args.splice(0, 1);
            log.debug('socket emit', JSON.stringify(args));
            socket.emit.apply(socket, args);
        }

        /**
         * @inner
         */
        function roomEmit() {
            log.debug('room emit', JSON.stringify(_.toArray(arguments)));
            room.emit.apply(room, arguments);
        }

        /**
         * @param {boolean} success
         * @param {string} message
         */
        function handleResponse(success, message) {
            if (message) {
                socketEmit(socket, 'message', {
                    type : success ? null : 'error-message',
                    message : message
                });
            }
        }

        /**
         * @param {string} message
         */
        function errorMessage(message) {
            showMessage(message, 'error-message');
        }

        /**
         * @param {string} message
         * @param {string=} type
         */
        function showMessage(message, type) {
            socketEmit(socket, 'message', {
                type : type,
                message : message
            });
        }

        /**
         * @inner
         * @param {string} nick
         * @returns {number}
         */
        function indexOf(nick) {
            for ( var i = 0; i < channel.online.length; i++) {
                if (channel.online[i].nick == nick) {
                    return i;
                }
            }
            return -1;
        }

        /**
         * @inner
         * @param {Object} dao
         * @param {string=} nick
         * @param {string=} password
         * @returns {$.Deferred}
         */
        function attemptNick(dao, nick, password) {
            var done = $.Deferred();

            /**
             * @inner
             */
            function fallback() {
                dao.nextNick().then(function(nick) {
                    log.debug('Nick fallback to ', nick);
                    attemptNick(dao, nick).then(function(success, errorMessage) {
                        done.resolve(success, errorMessage);
                    }, function(err) {
                        done.reject(err);
                    });
                }, function(err) {
                    done.reject(err);
                });
            }

            /**
             * @inner
             */
            function attempt(dbuser, password) {
                if (indexOf(dbuser.get('nick')) >= 0) {
                    log.debug('Attempted to nick to ', dbuser.get('nick'), ' but someone else is using that nick right now');
                    if (user.nick) {
                        done.resolve(false, msgs.alreadyBeingUsed);
                    } else {
                        fallback();
                    }
                } else {
                    dbuser.set('remote_addr', user.remote_addr).then(function() {
                        var online = !!user.nick;
                        user.nick = dbuser.get('nick');
                        socketEmit(socket, 'update', {
                            id : socket.id,
                            nick : dbuser.get('nick'),
                            access_level : dbuser.get('access_level'),
                            password : password || null
                        });
                        if (online) {
                            roomEmit('nick', {
                                id : socket.id,
                                nick : dbuser.get('nick')
                            });
                        } else {
                            channel.online.push(user);
                            log.debug('Successful join!');
                            roomEmit('join', {
                                id : socket.id,
                                nick : dbuser.get('nick')
                            });
                        }
                        done.resolve(true);
                    }, function(err) {
                        done.reject(err);
                    });
                }
            }

            if (nick && typeof nick == 'string') {
                dao.findUser(nick).then(function(dbuser) {
                    if (dbuser) {
                        if (dbuser.get('verified')) {
                            if (password) {
                                if (dbuser.verifyPassword(password)) {
                                    log.debug('Nick password was correct');
                                    attempt(dbuser, password);
                                } else {
                                    log.debug('Nick password was incorrect');
                                    if (user.nick) {
                                        done.resolve(false, msgs.invalidLogin);
                                    } else {
                                        fallback();
                                    }
                                }
                            } else if (user.nick) {
                                done.resolve(false, msgs.nickVerified);
                            } else {
                                fallback();
                            }
                        } else {
                            log.debug('Nick was not registered');
                            attempt(dbuser);
                        }
                    } else {
                        log.debug('Nick ', nick, ' does not exist, creating a new nick');
                        dao.createUser(nick, user.remote_addr).then(attempt, function(err) {
                            done.reject(err);
                        });
                    }
                }, function(err) {
                    done.reject(err);
                });
            } else {
                fallback();
            }

            return done.promise();
        }

        // -----------------------------------------------------------------------------
        // INITIALIZE THE CLIENT
        // -----------------------------------------------------------------------------

        dao(function(dao) {
            initClient(dao).always(function() {
                dao.release();
            });
        });
    });
}

var channelRegex = /^\/(\w*\/?)$/;
app.get(channelRegex, function(req, res) {
    var channelName = channelRegex.exec(req.url)[1];
    channels[channelName] || start(channelName);
    var index = fs.readFileSync('index.html').toString();
    _.each({
        channel : channelName,
        verifyEnabled : verifyEnabled
    }, function(value, key) {
        index = index.replace('${' + key + '}', value);
    });
    res.send(index);
});