/**
 * node-buspirate: Bus Pirate bindings for Node.js!
 * Letting you easily...
 *    - control your buspirate through a webserver
 *    - remotely debug things
 *    - much more...
 * See http://dangerousprototypes.com/2009/10/09/bus-pirate-raw-bitbang-mode/
 */

var SerialPort = require('serialport');
var colors = require('colors');
var util = require('util');
var events = require('events');

var Uart = require('./uart');
var Spi  = require('./spi');

module.exports = BusPirate;

/**
 * BusPirate constructor. Creates the object that sets up everything correctly
 * for higher level modules (uart, spi, etc).
 * @param {string} device  Path to device, eg /dev/tty.usbblah. Required
 * @param {number} baud  Baud rate to use. Default 115200
 * @param {bool} debug Debug mode flag, default false
 */
function BusPirate(device, baud, debug) {
    var self = this;

    events.EventEmitter.call(this);

    this.debug = debug || false;
    this.waiters = [];
    this.data_buffer = new Buffer('');

    baud = baud || 115200;
    this.log('info', 'Initialising BusPirate at ' + device);
    this.port = new SerialPort(device, { baudrate: baud });

    // Modes
    this.mode = '';
    this.uart = new Uart(self);
    this.spi = new Spi(self);

    // Once the port opens, enter binary mode (bitbang)
    this.port.on('open', function() {
        self.log('info', 'Device open', device);

        // Generic error handler
        self.port.on('error', function(err) {
            self.log('error', err);
            self.emit('error', err);
        });

        // As soon as it's open, reset console and go binmode
        self.reset_console()
            .then(() => {
                // Set up handlers for data sent from the buspirate
                self.port.on('data', function(data) {
                    self.log('receive', data);
                    self.emit('receive', data);


                    // Give the received data to any waiting functions
                    if(self.waiters.length > 0) {
                        self.data_buffer = Buffer.concat([self.data_buffer, data]);

                        for(var i = self.waiters.length - 1; i >= 0; i--) {
                            self.data_buffer = self.waiters[i](self.data_buffer, i, self.waiters);
                        }
                    }
                    return true;
                });
            })
            .then(() => self.enter_binmode())
            .then(() => {
                // Drain the serial port
                self.port.flush(function(err) {
                    self.emit('connected');

                    // Reset to binmode when exiting via Control-C
                    process.on('SIGINT', function() {
                        console.log('EXITING. Press Control-D to force'.red);
                        self.enter_binmode().then(() => process.exit(0));
                    });
                });
                return true;
            }, (err) => {
                console.log("Can't enter bin-mode: assuming BP is in uart-bridge mode".red);
                self.mode = 'uart_bridge';
                self.port.flush((err) => {
                    self.emit('connected');
                });
            })
            .catch((err) => {
                if(self.listeners('error').length) {
                    self.emit('error', err);
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
    // Enter ten times then #
    // note that if we're already in a binary mode, this will generate
    // a string of 0x00 response bytes, so we pause and then drain
    this.log("resetting console");

    return this.write([0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x23])
        .then(() => {
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    this.log("console reset");
                    resolve(true);
                }, 1000);
            });
        });
};

/**
 * Enter binary mode by writing 0x00 enough times
 */
BusPirate.prototype.enter_binmode = function() {

    if((this.mode == 'binmode') || (this.mode == 'uart_bridge')) {
        return Promise.resolve();
    }

    var tid;
    var p1 = new Promise((resolve, reject) => {
        var count = 0;

        // Periodically write 0x00, max 25 times
        tid = setInterval(() => {
            this.write(0x00);
            count++;

            if(count > 25) {
                clearInterval(tid);
                this.waiters = [];
                reject(new Error("cannot acquire binary mode"));
            }
        }, 20);
    });


    // ... until BBIO1 is received
    var p2 = this.expect('BBIO1')
        .then(() => {
            clearInterval(tid);
            this.log('Binmode entered successfully');
            this.mode = 'binmode';
            this.emit('mode', 'binmode');
            return true;
        });

    return Promise.race([p1, p2]);
};

/**
 * Switches the buspirate mode to MODE_NAME by sending the MODE_ID byte,
 * waiting for the correct response, MODE_ACK, and executing callback when
 * that happens. The mode module must pass in the above items in an object.
 * @param  {Array}   newmode  Array of constants that describe the new mode.
 */
BusPirate.prototype.switch_mode = function(newmode) {
    if(this.mode == 'uart_bridge') {
        return Promise.resolve('uart_bridge');
    }

    if(this.mode != 'binmode') {
        this.log('warn', 'Switching mode from ' + this.mode + ' to ' + newmode.MODE_NAME);

        var p = this.reset_console().then(() => this.enter_binmode());
    } else {
        this.log('info', 'Switching to mode: ' + newmode.MODE_NAME);

        var p = Promise.resolve();
    }

    return p.then(() => this.write(newmode.MODE_ID))
        .then(() => this.expect(newmode.MODE_ACK))
        .then(() => {
            this.log('mode', newmode.MODE_NAME);
            this.mode = newmode.MODE_NAME;
            this.emit('mode', newmode.MODE_NAME);
            return newmode.MODE_NAME;
        });
};

/**
 * Set the BusPirate peripherals to the specified state (asynchronously)
 * @return {err}  null if everything worked fine
 */
BusPirate.prototype.config_periph = function(opts) {
    // TODO: make sure we're in an allowed mode?
    var o = Object.assign({
        power: false,
        pullups: false,
        aux: false,
        mosi: false,
        clk: false,
        miso: false,
        cs: false
    }, opts);

    var code = 0x80 |
        (o.power << 6) |
        (o.pullups << 5) |
        (o.aux << 4) |
        (o.mosi << 3) |
        (o.clk < 2) |
        (o.miso << 1) |
        o.cs;

    if(o.pullups && this.mode == 'uart' && this.uart.settings.pin_output) {
        this.log('warn', 'Enabling pull up resistors with 3.3V UART output is probably a bad idea...');
    }

    return this.write(code)
        .then(() => {
            return this.expect(0x1);
        })
        .then(() => {
            this.log('peripherals', code);
            this.emit('peripherals', code);
        })
        .catch((err) => {
            console.log("TX error: ", err);
        });
};



/***** Util *****/

/*
 * Low level Serial write function
 * @param  {string|array|number} data  the data to write
 */
BusPirate.prototype.write = function(data) {
    this.log('write', data);

    if(Buffer.isBuffer(data)) {
        console.log("REPLACE");
        var tx = data;
    } else if(data instanceof Array || 'string' === typeof data) {
        var tx = data;
    } else {
        var tx = [data];
    }

    return new Promise((resolve, reject) => {
        this.port.write(tx, function(err) {
            if(err) {
                reject(err);
            } else {
                console.log("WROTE IT");
                resolve(true);
            }
        });
    });
};

/**
 * Wait for the specified data to arrive
 * @param  {string|array}   data
 */
BusPirate.prototype.expect = function(data) {

    // Convert data into a form that is easily compared with a Buffer
    if(data instanceof Array || 'string' === typeof data) {
        data = new Buffer(data);
    } else {
        data = new Buffer([data]);
    }

     this.log('listener', 'Added waiter for', format(data));

    // Add the waiter function to the start of the waiters array.  It is
    // iterated over backwards.  This way, the first added is the first called
    return new Promise((resolve, reject) => {
        this.waiters.unshift((data_received, idx, arr) => {
             this.log('listener', 'Want: ' + format(data) + ' got: ' + format(data_received));

            if(data instanceof RegExp) {
                var m = data.exec(data_received.toString('utf-8'));

                if(m) {
                    this.log('listener found', m[0]);
                    arr.splice(idx, 1);
                    resolve(m[0]);
                    return data_received.slice(m[0].length);
                }
            } else {

                if(data_received.length < data.length) {
                    return data_received;
                }

                // wait for '' => return the next lump of data that arrives
                if(data.length === 0) {
                    data = data_received;
                } else {
                    for(var i = data.length - 1; i >= 0; i--) {
                        if(data[i] != data_received[i]) {
                            return data_received;
                        }
                    }
                }

                // If matches, remove this waiter and the data it consumed
                this.log('listener found', data);
                arr.splice(idx, 1);
                resolve(data);

                return data_received.slice(data.length);
            }
        });
    });
};


/*
 * Debug logger - log(type, message, ...)
 */
BusPirate.prototype.log = function() {
    var argv = [].slice.call(arguments);

    if (this.debug) {
        console.log('BP: '.cyan + argv.shift().green + ' ' + argv.map(format).join(' '));
    }
};

/**
 * Formatting for the logger items.  eg numbers are shown in hex
 */
function format(item) {
    if (typeof item === 'number') {
        return '0x' + item.toString(16);
    }
    else if (Buffer.isBuffer(item)) {
        var dirty = item.toString('utf-8');
        var clean = dirty.replace(/[\x00-\x1F\x7F-\x9F]/g, ".");
        return clean + '[' + item.toString('hex').blue + ']';
    }
    else if (typeof item === 'object') {
        return item.map(format);
    }
    else if((typeof item === 'string') || (item instanceof String)) {
        // allow 0x1B thru for ANSI colour escape sequences
        var clean = item.replace(/[\x00-\x1A\x1C-\x1F\x7F-\x9F]/g, ".");

        return clean;
    }
    else return item;
}
