const EventEmitter = require('node:events');
// When you use require, it doesn't look at the global modules folder. 
// Fix it by writing this in the (bash) terminal: 
// # export NODE_PATH=$(npm root -g)

const EOF = 0; // \0
const NL = 10; // \n
const NR = 13; // \n
const NLT = '\n';
const NRT = '\r\n';
const NL2T = '\n\n';
const NRL2T = '\r\n\r\n';
const D2T = ':';

// we don't konw is it frame?
const errInvalReq = { code: 400, message: 'inval_req' };
// we konw - it's frame
const errInvalFrame = { code: 400, message: 'inval_frame' };
// part of frame is too big
const errTooBig = { code: 413, message: 'too_big' };
// error in client callback
const errGeneric = { code: 500, message: 'genr_err' };

const isAsciiUpper = (ch) => {
    // A <= ch <= Z
    return (65 <= ch) && (ch <= 90);
}
const isPrintNoSpace = (ch) => {
    return (32 < ch) && (ch <= 126);
}
const isPrint = (ch) => {
    return (32 <= ch) && (ch <= 126);
}

// All commands and header names referenced in STOMP are case sensitive.
// Header content-length
// All frames MAY include a content-length header. 
// This header is an octet count for the length of the message body. 
// If a content-length header is included, this number of octets MUST be read, 
// regardless of whether or not there are NULL octets in the body. 
// The frame still needs to be terminated with a NULL octet.
// If a frame body is present, the SEND, MESSAGE and ERROR frames 
// SHOULD include a content-length header to ease frame parsing. 
// If the frame body contains NULL octets, 
// the frame MUST include a content-length header.
const contentLengthHeader = 'content-length';
const isHeaderContentLength = (value) => {
    return contentLengthHeader == value;
}

//  stompTok
//      .on('frameStart')           ->  begin frame
//      .on('method', name)         ->  receive method
//      .on('headerKey', value)     ->  receive header key
//      .on('headerVal', value)     ->  receive header val
//      .on('frameEnd')             ->  end frame
//      .on('error', err)           ->  parse error
//  +   abort(err)                  ->  abort parse
//  +   parse(Buffer.from(somedata))


class StompTok extends EventEmitter {
    constructor() {
        super();
        this.parseState = this.startState;
        this.contentLength = 0;
        this.contentLeft = 0;
        this.prevData = null;
    }

    callNextState(idx, data, nextState) {
        this.parseState = nextState;
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    startState(data) {
        const { length } = data;
        // find begin of frame
        // skip wrong data or heart-beat
        let idx = 0;
        do {
            const ch = data[idx];
            if (!((ch == NL) || (ch == NR) || (ch == EOF))) {
                break;
            }
        } while (++idx < length);
        
        this.emit('frameStart');
        this.contentLength = 0;
        this.contentLeft = 0;

        return this.callNextState(idx, 
            data, this.frameState);
    }

    frameState(data) {
        // try to find frame(text-part)[\n\n]body(binary-part)[separator]
        let bodySep = NL2T;
        let headerSep = NLT;
        let idx = data.indexOf(bodySep);
        if (idx == -1) {
            // try to find frame(text-part)[\r\n\r\n]body(binary-part)[separator]
            bodySep = NRL2T;
            headerSep = NRT;
            idx = data.indexOf(bodySep);
        }
        // frame found
        if (idx != -1) {
            const textPart = data.subarray(0, idx).toString('ascii');
            let tokenArray = textPart.split(headerSep);
            const { length } = tokenArray;
            // minimum 1 elem
            if (length) {
                const methodName = tokenArray[0];
                this.emit('method', methodName);
                for (let i = 1; i < length; ++i) {
                    const kvArr = tokenArray[i].split(D2T);
                    if (kvArr.length == 2) {
                        const headerKey = kvArr[0];
                        const headerVal = kvArr[1];
                        if ((this.contentLength == 0) && isHeaderContentLength(headerKey)) {
                            this.contentLength = this.contentLeft = parseInt(headerVal);            
                        }
                        this.emit('headerKey', headerKey);
                        this.emit('headerVal', headerVal);
                    } else {
                        this.emit('error', errInvalFrame);
                        return data.subarray(idx);
                    }
                }
            } else {
                this.emit('error', errInvalReq);
                return data.subarray(idx);
            }

            idx += bodySep.length;
            return this.callNextState(idx, 
                data, this.endOrBodyState);
        }
        return data;
    }

    endOrBodyState(data) {
        if (data.length) {
            // we know body length
            if (this.contentLength) {
                return this.callNextState(0, 
                    data, this.bodyState);
            }

            // detect frame end, or body with no length
            let idx = 0;
            const { length } = data;
            do {
                let ch = data[idx++];
                if (EOF == ch) {
                    if (idx > 1) {
                        this.emit('body', data.subarray(0, --idx));
                    }
                    this.emit('frameEnd');
                    return this.callNextState(idx, 
                        data, this.startState);
                }
            } while (idx < length);
            
            return data.subarray(idx);
        }

        return data;
    }

    bodyState(data) {
        let { contentLeft } = this;
        let idx = Math.min(data.length, contentLeft);
    
        if (idx > 0) {
            contentLeft -= idx;
            this.contentLeft = contentLeft;
            this.emit('body', data.subarray(0, idx));
        }

        // определяем нужно ли менять состояние
        if (contentLeft == 0) {
            return this.callNextState(idx, 
                data, this.endState);
        }

        return this.callNextState(idx, 
            data, this.bodyState);
    }

    endState(data) {
        let idx = 0;
        if (EOF == data[idx]) {
            ++idx;
            this.emit('frameEnd');
        } else {
            this.emit('error', errInvalFrame);
        }

        return this.callNextState(idx, 
            data, this.startState);
    }

    concat(data) {  
        if (this.prevData) {
            // если хранили остаток присоединяем его
            const rc = Buffer.concat([this.prevData, data]);
            this.prevData = null;
            return rc;
        }
        return data;
    }

    store(data) {
        const { length } = data;
        if (length > 500) {
            // too big
        }
        this.prevData = data;
    }

    parse(input) {
        let data = this.concat(input);
        // prev buffer length
        const { length } = data;
        while (data.length) {
            // now data become subarray of original data
            data = this.parseState(data);
            // not parsed if length not changed
            if (length == data.length) {
                this.store(data);
                return false;
            }
        }
        return true;
    }
}
