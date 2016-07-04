module.exports = function(RED) {
    "use strict";
    var mqtt = require("mqtt");
    var util = require("util");
    var isUtf8 = require('is-utf8');
    var fs = require('fs');
    var proxy = require('proxy-agent');
    var awsIot = require('aws-iot-device-sdk');

    function matchTopic(ts,t) {
        if (ts == "#") {
            return true;
        }
        var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
        return re.test(t);
    }

    function MQTTBrokerNode(n) {
        RED.nodes.createNode(this,n);

        // Configuration options passed by Node Red
        this.region = n.region;
        this.broker = "data.iot."+this.region+".amazonaws.com";
        this.port = 8883;
        this.clientid = n.clientid;
        this.usetls = n.usetls;
        this.certdir = n.certdir;
        this.verifyservercert = n.verifyservercert;
        this.compatmode = n.compatmode;
        this.usewss = n.usewss;
        this.keepalive = n.keepalive;
        this.cleansession = n.cleansession;
        this.useproxy = n.useproxy;
        this.proxyhost = n.proxyhost;
        this.proxyport = n.proxyport;
        this.proxyauth = n.proxyauth;
        this.proxyuser = n.proxyuser;
        this.proxypassword = n.proxypassword;
        
        // Config node state
        this.brokerurl = "";
        this.connected = false;
        this.connecting = false;
        this.closing = false;
        this.options = {};
        this.queue = [];
        this.subscriptions = {};

        if (n.birthTopic) {
            this.birthMessage = {
                topic: n.birthTopic,
                payload: n.birthPayload || "",
                qos: Number(n.birthQos||0),
                retain: n.birthRetain=="true"|| n.birthRetain===true
            };
        }

        if (this.credentials) {
            this.accessKeyId = this.credentials.accessKeyId;
            this.secretKey = this.credentials.secretKey;
        }

        // If the config node is missing certain options (it was probably deployed prior to an update to the node code),
        // select/generate sensible options for the new fields
        if (typeof this.usetls === 'undefined'){
            this.usetls = false;
        }
        if (typeof this.certdir === 'undefined'){
            this.cerdir = "certs";
        }
        if (typeof this.useproxy === 'undefined'){
            this.useproxy = false;
        }
        if (typeof this.proxyauth === 'undefined'){
            this.proxyauth = false;
        }
        if (typeof this.compatmode === 'undefined'){
            this.compatmode = true;
        }
        if (typeof this.usewss === 'undefined'){
            this.usewss = true;
        }
        if (typeof this.verifyservercert === 'undefined'){
            this.verifyservercert = false;
        }
        if (typeof this.keepalive === 'undefined'){
            this.keepalive = 60;
        } else if (typeof this.keepalive === 'string') {
            this.keepalive = Number(this.keepalive);
        }
        if (typeof this.cleansession === 'undefined') {
            this.cleansession = true;
        }

        // Create the URL to pass in to the MQTT.js library
        if (this.brokerurl === "") {
            if (this.usetls) {
                this.brokerurl="mqtts://";
            } else {
                this.brokerurl="mqtt://";
            }
            if (this.broker !== "") {
                this.brokerurl = this.brokerurl+this.broker+":"+this.port;
            } else {
                this.brokerurl = this.brokerurl+"localhost:1883";
            }
        }

        if (!this.cleansession && !this.clientid) {
            this.cleansession = true;
            this.warn(RED._("awsiot.errors.nonclean-missingclientid"));
        }

        // Build options for passing to the MQTT.js API
        this.options.clientId = this.clientid || 'awsiot_' + (1+Math.random()*4294967295).toString(16);
        this.options.keepalive = 10000;//this.keepalive;
        this.options.clean = this.cleansession;
        this.options.reconnectPeriod = RED.settings.mqttReconnectTime||5000;
        if (this.compatmode == "true" || this.compatmode === true){
            this.options.protocolId = 'MQIsdp';
            this.options.protocolVersion = 3;
        }

        this.options.rejectUnauthorized = (this.verifyservercert == "true" || this.verifyservercert === true);
    
        this.options.region = this.region;

	    // Handle certificate management
        this.trace;// = console.error;
	    
	    this.options.debug = false;
	    if (this.usewss) {
	    	if (!this.accessKeyId || !this.secretKey) {
	    		throw new Error("accessKeyId and secretKey are mandatory for wss protocol usage !");
	    	}
	        this.options.protocol = 'wss';
	        this.options.accessKeyId = this.accessKeyId;
	        this.options.secretKey = this.secretKey;
			this.options.rejectUnauthorized = false;
			if (this.useproxy) {
				var p = this.proxyhost+":"+this.proxyport;
				if (this.proxyauth) {
					p = this.proxyuser + ":" + this.proxypassword + "@" + p;
				}
				this.options.websocketOptions = {
					agent: proxy("http://"+p)
				};
			}
	    } else {
            var certDir = require('path').resolve(__dirname + "/../../../../../../" + this.certdir);
            var KEY = fs.readFileSync(certDir + '/private.pem.key');
            var CERT = fs.readFileSync(certDir + '/certificate.pem.crt');
            var TRUSTED_CA_LIST = fs.readFileSync(certDir + '/root-CA.crt');
		    this.options.key = KEY;
		    this.options.cert = CERT;
		    this.options.ca = TRUSTED_CA_LIST;
	    }
	    

        
        if (n.willTopic) {
            this.options.will = {
                topic: n.willTopic,
                payload: n.willPayload || "",
                qos: Number(n.willQos||0),
                retain: n.willRetain=="true"|| n.willRetain===true
            };
        }

        
        this.trace && this.trace("Options: "+JSON.stringify(this.options,null,2));
        // Define functions called by MQTT in and out nodes
        var node = this;
        this.users = {};

        this.register = function(mqttNode){
            node.users[mqttNode.id] = mqttNode;
            if (Object.keys(node.users).length === 1) {
                node.connect();
            }
        };

        this.deregister = function(mqttNode,done){
            delete node.users[mqttNode.id];
            if (node.closing) {
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (node.client) {
                    return node.client.end(done);
                }
            }
            done();
        };

        var self = this;
        this.connect = function () {
            if (!node.connected && !node.connecting) {
                node.connecting = true;   
                //if (self.usewss) {
                	node.client = awsIot.device(node.options);
                //} else {
                	//node.client = mqtt.connect(node.brokerurl ,node.options);
                //}
                node.client.setMaxListeners(0);
                // Register successful connect or reconnect handler
                node.client.on('connect', function () {
                	self.trace && self.trace("On connect");
                    node.connecting = false;
                    node.connected = true;
                    node.log(RED._("awsiot.state.connected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({fill:"green",shape:"dot",text:"common.status.connected"});
                        }
                    }
                    // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                    node.client.removeAllListeners('message');

                    
                    try {
                    // Re-subscribe to stored topics
		                for (var s in node.subscriptions) {
		                    var topic = s;
		                    var qos = 0;
		                    for (var r in node.subscriptions[s]) {
		                        qos = Math.max(qos,node.subscriptions[s][r].qos);
		                        node.client.on('message',node.subscriptions[s][r].handler);
		                    }
		                    var options = {qos: qos};
		                    node.client.subscribe(topic, options);
		                }
                    } catch(e) {
                    	console.error(e.stack);
                    }
                    // Send any birth message
                    if (node.birthMessage) {
                        node.publish(node.birthMessage);
                    }
                });
                node.client.on("reconnect", function() {
                	self.trace && self.trace("On reconnect");
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({fill:"yellow",shape:"ring",text:"common.status.connecting"});
                        }
                    }
                });
                // Register disconnect handlers
                node.client.on('close', function () {
                	self.trace && self.trace("On close");
                    if (node.connected) {
                        node.connected = false;
                        node.log(RED._("awsiot.state.disconnected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"red",shape:"ring",text:"common.status.disconnected"});
                            }
                        }
                    } else if (node.connecting) {
                        node.log(RED._("awsiot.state.connect-failed",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                    }
                });

                // Register connect error handler
                node.client.on('error', function (error) {
                	self.trace && self.trace("On error: "+error.stack);
                    if (node.connecting) {
                        node.client.end();
                        node.connecting = false;
                    }
                });
            }
        };

        this.subscribe = function (topic,qos,callback,ref) {
            ref = ref||0;
            node.subscriptions[topic] = node.subscriptions[topic]||{};
            var sub = {
                topic:topic,
                qos:qos,
                handler:function(mtopic,mpayload, mpacket) {
                    if (matchTopic(topic,mtopic)) {
                        callback(mtopic,mpayload, mpacket);
                    }
                },
                ref: ref
            };
            node.subscriptions[topic][ref] = sub;
            if (node.connected) {
                node.client.on('message',sub.handler);
                var options = {};
                options.qos = qos;
                node.client.subscribe(topic, options);
            }
        };

        this.unsubscribe = function (topic, ref) {
            ref = ref||0;
            var sub = node.subscriptions[topic];
            if (sub) {
                if (sub[ref]) {
                    node.client.removeListener('message',sub[ref].handler);
                    delete sub[ref];
                }
                if (Object.keys(sub).length == 0) {
                    delete node.subscriptions[topic];
                    if (node.connected){
                        node.client.unsubscribe(topic);
                    }
                }
            }
        };

        this.publish = function (msg) {
            if (node.connected) {
                if (!Buffer.isBuffer(msg.payload)) {
                    if (typeof msg.payload === "object") {
                        msg.payload = JSON.stringify(msg.payload);
                    } else if (typeof msg.payload !== "string") {
                        msg.payload = "" + msg.payload;
                    }
                }

                var options = {
                    qos: msg.qos || 0,
                    retain: msg.retain || false
                };
                node.client.publish(msg.topic, msg.payload, options, function (err){return;});
            }
        };

        this.on('close', function(done) {
            this.closing = true;
            if (this.connected) {
                this.client.once('close', function() {
                    done();
                });
                this.client.end();
            } else {
                done();
            }
        });

    }

    RED.nodes.registerType("awsiot-broker",MQTTBrokerNode,{
        credentials: {
            accessKeyId: {type:"text"},
            secretKey: {type: "password"}
        }
    });

    function MQTTInNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.broker = n.broker;
        this.brokerConn = RED.nodes.getNode(this.broker);
        if (!/^(#$|(\+|[^+#]*)(\/(\+|[^+#]*))*(\/(\+|#|[^+#]*))?$)/.test(this.topic)) {
            return this.warn(RED._("awsiot.errors.invalid-topic"));
        }
        var node = this;
        if (this.brokerConn) {
            this.status({fill:"red",shape:"ring",text:"common.status.disconnected"});
            if (this.topic) {
                node.brokerConn.register(this);
                this.brokerConn.subscribe(this.topic,0,function(topic,payload,packet) {
                    if (isUtf8(payload)) { payload = payload.toString(); }
                    var msg = {topic:topic,payload:payload, qos: packet.qos, retain: packet.retain};
                    if ((node.brokerConn.broker === "localhost")||(node.brokerConn.broker === "127.0.0.1")) {
                        msg._topic = topic;
                    }
                    node.send(msg);
                }, this.id);
                if (this.brokerConn.connected) {
                    node.status({fill:"green",shape:"dot",text:"common.status.connected"});
                }
            }
            else {
                this.error(RED._("awsiot.errors.not-defined"));
            }
            this.on('close', function(done) {
                if (node.brokerConn) {
                    node.brokerConn.unsubscribe(node.topic,node.id);
                    node.brokerConn.deregister(node,done);
                }
            });
        } else {
            this.error(RED._("awsiot.errors.missing-config"));
        }
    }
    RED.nodes.registerType("awsiot in",MQTTInNode);

    function MQTTOutNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.qos = n.qos || null;
        this.retain = n.retain;
        this.broker = n.broker;
        this.brokerConn = RED.nodes.getNode(this.broker);
        var node = this;

        if (this.brokerConn) {
            this.status({fill:"red",shape:"ring",text:"common.status.disconnected"});
            this.on("input",function(msg) {
                if (msg.qos) {
                    msg.qos = parseInt(msg.qos);
                    if ((msg.qos !== 0) && (msg.qos !== 1) && (msg.qos !== 2)) {
                        msg.qos = null;
                    }
                }
                msg.qos = Number(node.qos || msg.qos || 0);
                msg.retain = node.retain || msg.retain || false;
                msg.retain = ((msg.retain === true) || (msg.retain === "true")) || false;
                if (node.topic) {
                    msg.topic = node.topic;
                }
                if ( msg.hasOwnProperty("payload")) {
                    if (msg.hasOwnProperty("topic") && (typeof msg.topic === "string") && (msg.topic !== "")) { // topic must exist
                        this.brokerConn.publish(msg);  // send the message
                    }
                    else { node.warn(RED._("awsiot.errors.invalid-topic")); }
                }
            });
            if (this.brokerConn.connected) {
                node.status({fill:"green",shape:"dot",text:"common.status.connected"});
            }
            node.brokerConn.register(node);
            this.on('close', function(done) {
                node.brokerConn.deregister(node,done);
            });
        } else {
            this.error(RED._("awsiot.errors.missing-config"));
        }
    }
    RED.nodes.registerType("awsiot out",MQTTOutNode);
};
