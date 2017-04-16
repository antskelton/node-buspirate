/**
 * The UART mode for BusPirate
 * http://dangerousprototypes.com/2009/10/19/bus-pirate-binary-uart-mode/
 */

var util = require('util');
var events = require('events');

module.exports = Uart;


/**
 * Uart - gives a buspirate uart mode capabilities
 */
function Uart(buspirate) {
    events.EventEmitter.call(this);

    this.bp = buspirate;
    this.started = false;
    this.echo_rx_on = false;
    this.settings = {};

    // Special constants NEEDED to change mode
    this.constants = {
        MODE_ID: 0x03,
        MODE_NAME: 'uart',
        MODE_ACK: 'ART1'
    };

    this.bp.on('receive', (data) => {
        // Handle incoming data if in UART mode
        if(this.started) {
            this.emit('data', data);
        }
    });

    this.bp.on('mode', (m) => {
        if(m != this.constants.MODE_NAME) {
            this.started = false;
        }
    });
}

// Event emitter!
util.inherits(Uart, events.EventEmitter);


/**
 * Call .start() to change the buspirate mode and begin Uart
 * It changes mode and then sets the UART options
 * @param  {array} options options to pass on to setopts
 */
Uart.prototype.start = function(options) {
    return this.bp.switch_mode(this.constants)
        .then((mode) => {
            if(mode == this.constants.MODE_NAME) {
                this.started = true;
                return this.setopts(options);
            } else if(mode == 'uart_bridge') {
                this.started = true;
                this.emit('ready');
                return true;
            } else {
                return false;
            }
        })
        .catch((err) => {
            this.bp.log('error', err);
        });
};


/**
 * A set of of defaults for UART mode
 */
uart_defaults = {
    baudrate:      9600, // UART baud rate
    pin_output:    1,    // 0=HiZ, 1=3.3V
    data_bits:     8,    // 8 or 9
    parity_bit:   'N',   // 'N' or 'E' or 'O'
    stop_bits:     1,    // 1 or 2
    idle_polarity: 1     // 1=idle1, 0=idle0
};

/**
 * Setopts sets up the BusPirate as required, emitting 'ready' when done
 * @param  {array} options To override the defaults above
 */
Uart.prototype.setopts = function(options) {
    var opts = {};
    var data_par = 0;
    options = options || {};

    // Must be started first
    if(!this.started) {
        return this.start(options);
    }

    // Parse options
    for(var opt in uart_defaults) {
        opts[opt] = options[opt] || uart_defaults[opt];
    }
    this.settings = opts;

    // Baudrate codes (buspirate protocol ART1)
    var bauds = {
        300:    0x60,
        1200:   0x61,
        2400:   0x62,
        4800:   0x63,
        9600:   0x64,
        19200:  0x65,
        31250:  0x66,
        38400:  0x67,
        57600:  0x68,
        115200: 0x69  // The DP page is wrong!
    };

    var baudcmd = bauds[opts.baudrate] || bauds[uart_defaults.baudrate];
    var w = (opts.pin_output << 4);
    var xx = ((opts.data_bits == 9) ? 3 : "NEO".indexOf(opts.parity_bit)) << 2;
    var y = ((opts.stop_bits == 2) ? 1 : 0) << 1;
    var z = (opts.idle_polarity ? 0 : 1);
    var config = 0x80 | w | xx | y | z;
    var err = false;

    return this.bp.write(baudcmd)
        .then(() => this.bp.expect(0x01))
        .then(() => this.bp.write(config))
        .then(() => this.bp.expect(0x1))
        .then(() => {
            this.emit('ready');
            this.bp.log('uart', 'Started, baud: ' + opts.baudrate);
            return true;
        })
        .catch((err) => {
            this.bp.emit('error', err);
        });
};


/*****[ Uart operations routines ]******************************************/

/**
 * Set RX echoing.  Disabled by default so that rec codes aren't corrupted
 * @param {bool} on Whether to enable it or not
 */
Uart.prototype.echo_rx = function(on) {
    var code = (on) ? 0x02 : 0x03;

    if(this.bp.mode == 'uart_bridge') {
        return Promise.resolve(true);
    }

    return this.bp.write(code)
        .then(() => this.bp.expect(0x01))
        .then(() => {
            this.bp.log('uart', 'RX echo is now: ' + on);
            this.echo_rx_on = on;
            this.emit('rx_echo', on);
            return true;
        });
};


/**
 * Start uart bridge mode.  The only way to exit is to unplug the buspirate
 */
Uart.prototype.uart_bridge = function() {
    if(this.bp.mode == 'uart_bridge') {
        return Promise.resolve(true);
    }

    return this.bp.write(0x0f)
        .then(() => {
            this.bp.log('info', 'Uart bridge started - disconnect BP to reset');
            this.bp.mode = 'uart_bridge';
            this.emit('uart_bridge');
            return true;
        });
};


/**
 * Write a block of 1-16 bytes to the Uart connection
 */
Uart.prototype.write_block = function(buffer) {
    var test = [];
    var lenbyte = 0x10 + buffer.length - 1;

    if(buffer.length > 16) {
        return new Error('Cannot send more than 16 bytes at once');
    }

    if(!this.started) {
        return new Error('Uart must be started before writing');
    }

    // Build an array to wait for.  Basically a bunch of 0x01s
    for(var i = buffer.length - 1; i >= 0; i--) {
        test.push(0x01);
    }

    return this.bp.write(lenbyte)
        .then(() => this.bp.expect(0x1))
        .then(() => this.bp.write(buffer))
        .then(() => this.bp.expect(test));
};

Uart.prototype.write = function(buffer) {
    function chunkSubstr(str, size) {
        var numChunks = Math.ceil(str.length / size);
        var chunks = new Array(numChunks);

        for(var i = 0, o = 0; i < numChunks; ++i, o += size) {
            chunks[i] = str.substr(o, size);
        }

        return chunks;
    }

    if(this.bp.mode == 'uart_bridge') {
        return this.bp.write(buffer);
    } else {
        var chunks = chunkSubstr(buffer, 16);
        console.log("CHUNKS ", chunks);

        var p = Promise.resolve(true);

        chunks.forEach((chunk) => {
            p = p.then(() => this.write_block(chunk));
        });

        return p;
    }

};

// TODO: Make uart a Stream
