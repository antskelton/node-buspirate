/**
 * See http://dangerousprototypes.com/2009/10/09/bus-pirate-raw-bitbang-mode/
 */

var SerialPort = require('serialport').SerialPort,
	asyncblock = require('asyncblock'),
	colors     = require('colors'),
	util       = require('util'),
	Buffer     = require('buffer').Buffer,
	events     = require('events');

var Uart = require('./lib/uart');

module.exports = BusPirate;

/**
 * BusPirate constructor
 * @param {string} device  Path to device, eg /dev/tty.usbblah. Required
 * @param {number} baud  Baud rate to use. Default 115200
 * @param {bool} debug Debug mode flag, default false
 */
function BusPirate(device, baud, debug) {
	events.EventEmitter.call(this);
	var self = this;
	this.debug = debug || true;
	self.waiters = [];

	baud = baud || 115200;
	this.log('info', 'Initialising BusPirate at '+device);
	this.port = new SerialPort(device, { baudrate: baud });

	// Modes
	this.mode = '';
	this.uart = new Uart(self);

	// Once the port opens, enter binary mode (bitbang)
	this.port.on('open', function() {
		self.log('Device open', device);

		self.reset_console();
		self.enter_binmode(function(err) {
			if (err) {
				if(self.listeners('error').length)
					self.emit('error', err);
				else
					throw new Error(err);
			}
			else {
				// Drain the serial port
				self.port.flush(function() {
					self.emit('connected');
				});
			}
		});

		self.port.on('error', function(err) {
			self.log('error', err);
			self.emit('error', err);
		});

		// Set up handlers for data sent from the buspirate
		self.port.on('data', function(data) {
			self.log('receive', format(data).red);
			self.emit('receive', data);
			console.log(self.waiters);

			if (self.waiters.length > 0) {
				for (var i = self.waiters.length - 1; i >= 0; i--) {
					data = self.waiters[i](data, i, self.waiters);
				}
			}
		});
	});
}

// BusPirate is an event emitter!
util.inherits(BusPirate, events.EventEmitter);


/**
 * Make sure we aren't in any menus or anything, and send # to reset
 */
BusPirate.prototype.reset_console = function() {
	this.write([0x0d, 0x0d, 0x0d, 0x0d, 0x0d,          // Enter, 10 times
				0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x23]);  // and then #
};

/**
 * Enter binary mode by writing 0x00 enough times
 */
BusPirate.prototype.enter_binmode = function(callback) {
	// Periodically write 0x00...
	var self = this;
	var binmodeIntervalID = setInterval(function(self) {
		self.write(0x00);
	}, 20, this);

	// ... until BBIO1 is received
	this.wait_for_data('BBIO1', function() {
		clearInterval(binmodeIntervalID);
		self.log('Binmode entered successfully');
		self.mode = 'binmode';
		self.emit('mode', 'binmode');
		if (callback) callback();
	});
};

/**
 * Switches the buspirate mode by sending the mode id byte, waiting for
 * the correct response, and executing callback when that happens.
 * The mode module must pass in the above items in an object.
 */
BusPirate.prototype.switch_mode = function(newmode, callback) {
	var self = this;
	if (this.mode != 'binmode') {
		this.log('warn', 'Switching mode from '+this.mode+' to '+newmode.MODE_NAME);
		this.reset_console();
		this.enter_binmode();
	}

	this.log('info', 'Switching to mode: '+newmode.MODE_NAME);
	this.write(newmode.MODE_ID);
	this.wait_for_data(newmode.MODE_ACK, function(err) {
		self.log('mode', newmode.MODE_NAME);
		self.mode = newmode.MODE_NAME;
		self.emit('mode', newmode.MODE_NAME);

		if (callback) callback(err, newmode.MODE_NAME);
	});
};

/**
 * Set the BusPirate peripherals to the specified state (synchronously)
 * @return {err}  null if everything worked fine
 */
BusPirate.prototype.config_periph = function(power, pullups, aux, cs, callback) {
	// TODO: make sure we're in an allowed mode?
	var code = 0x40 + power*8 + pullups*4 + aux*2 + cs;
	var self = this;

	this.write(code);
	this.wait_for_data(0x01, function() {
		self.log('peripherals', code);
		self.emit('peripherals', code);
		if (callback) callback();
	});
};



/***** Util *****/

/*
 * Low level Serial write function
 * @param  {string|array|number} data  the data to write
 * @param  {Function} callback  Function to execute after writing
 */
BusPirate.prototype.write = function(data, callback) {
	this.log('write', data);
	if (data instanceof Array || 'string' === typeof data)
		this.port.write(data, callback);  // TODO: check num bytes written?
	else
		this.port.write([data], callback);
};

/**
 * Synchronous version of the above - only returns when it's finished writing
 * Same parameters as above.  Uses Fibers - event loop isn't blocked.
 */
BusPirate.prototype.sync_write = function(flow, data) {
	var self = this;

	// TODO: catch errors in write and read data
	this.write(data, flow.add());
	flow.wait();
};

/**
 * Wait for the specified data to arrive
 * @param  {string|array}   data
 * @param  {Function} callback
 */
// BusPirate.prototype.wait_for_data = function(data, callback) {
// 	var self = this;

// 	// Convert data into a form that is easily compared
// 	if (data instanceof Array || 'string' === typeof data)
// 		data = new Buffer(data);
// 	else
// 		data = new Buffer([data]);

// 	// A (private) function to compare received data with the required data
// 	var testdata = function(data_received) {
// 		self.log('listener', 'Waiting for: '+format(data).blue+' got: '+format(data_received).blue);
// 		if (data.length != data_received.length)
// 			return;

// 		for (var i = data.length - 1; i >= 0; i--) {
// 			if (data[i] != data_received[i])
// 				return;
// 		}

// 		// Remove the listener when the desired data arrives
// 		self.log('listener', 'Found '+format(data).green);
// 		self.removeListener('receive', testdata);
// 		callback(null);
// 	};

// 	// Set up an event handler to compare newly received data
// 	this.on('receive', testdata);
// };


BusPirate.prototype.wait_for_data = function(data, callback) {
	var self = this;

	// Convert data into a form that is easily compared with a Buffer
	if (data instanceof Array || 'string' === typeof data)
		data = new Buffer(data);
	else
		data = new Buffer([data]);

	this.waiters.push(function(data_received, idx, arr) {
		self.log('Listener', 'Waiting for: '+format(data).blue+' got: '+format(data_received).blue);
		if (data_received.length < data.length)
			return data_received;

		for (var i = data.length - 1; i >= 0; i--) {
			if (data[i] != data_received[i])
				return data_received;
		}

		self.log('Listener', 'Found '+format(data).green);
		arr.splice(idx, 1);
		callback();
		return data_received.slice(data.length);
	});
};




/**
 * Synchronous version of wait, similar to sync_write, above, optional timeout
 */
BusPirate.prototype.sync_wait = function(flow, data, timeout) {
	flow.on('taskTimeout', function() {
		return new Error('Timeout while setting baud rate');
	});

	this.wait_for_data(data, flow.add({timeout: timeout}));
	flow.wait();
};


/*
 * Debug logger - log(type, message, ...)
 */
BusPirate.prototype.log = function() {
	var argv = [].slice.call(arguments);

	if (this.debug) {
		console.log(argv.shift().green + ' ' + argv.map(format).join(', '));
	}
};

/**
 * Formatting for the logger items.  eg numbers are shown in hex
 */
function format(item) {
	if (typeof item === 'number') {
		return '0x'+item.toString(16);
	}
	else if (Buffer.isBuffer(item)) {
		return item.toString('utf-8') +'['+item.toString('hex')+']';
	}
	else if (typeof item === 'object') {
		return item.map(format);
	}
	else return item;
}