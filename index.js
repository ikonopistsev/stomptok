const EventEmitter = require('node:events');

class ParserStack {
    constructor(size) {
        // idx указывает на следующий свободный элемент
        this.idx = 0;
        this.arr = Buffer.alloc(size);
    }

    push(byteVal) {
        const { idx, arr } = this;
        const { byteLength } = arr;
        if (idx < byteLength) {
            this.arr[this.idx++] = byteVal;
        }
        return idx != this.idx;
    }

    clear() {
        this.idx = 0;
    }

    pop() {
        const { idx, arr } = this;
        this.clear();
        return arr.subarray(0, idx);
    }

    get size() {
        return this.idx;
    }

    get capacity() {
        const { idx, arr } = this;
        return arr.byteLength - idx;
    }
}

const NL = 10; // \n
const NR = 13; // \r
const EOF = 0; // \0
const D2 = 58; // :
const BC = 67; // C
const BL = 76; // L
const SC = 99; // c
const SL = 108;// l

// we don't konw is it frame?
const errInvalReq = { code: 400, message: 'inval_req' };
// we konw - it's frame
const errInvalFrame = { code: 400, message: 'inval_frame' };
// part of frame is too big
const errTooBig = { code: 413, message: 'too_big' };
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

class StompTok extends EventEmitter {
    constructor() {
        super();
        this.stackBuf = new ParserStack(2048);
        // state machine
        this.parseState = this.startState;
        
        // header 'content-length' data
        this.contentLength = 0;
        // how many content left
        this.contentLeft = 0;
        // is previous header key was content-length?
        this.isContentLength = false;

        const e = () => {};
        this.onFrameStart = e;
        this.onMethod = e;
        this.onHeaderKey = e;
        this.onHeaderVal = e;
        this.onBody = e;
        this.onFrameEnd = e;
        this.onError = e;
    }

    callNextState(idx, data, nextState) {
        this.parseState = nextState;
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    startState(data) {
        let idx = 0;
        const { length } = data;
        do {
            let ch = data[idx++];
            if ((ch == NL) || (ch == NR) || (ch == EOF)) {
                continue;
            }

            if (!isAsciiUpper(ch)) {
                this.emitOnError(errInvalReq);
                return data.subarray(idx);
            }

            this.emitFrameStart();
            this.stackBuf.clear();
            this.stackBuf.push(ch);
            this.contentLength = 0;
            this.contentLeft = 0;
            this.isContentLength = false;
            return this.callNextState(idx, 
                data, this.methodState);
        } while (idx < length);
        // EOF data
        return { length: 0 };
    }

    methodState(data) {
        let idx = 0;
        const { length } = data;
        do {
            let ch = data[idx++];
            if (isAsciiUpper(ch)) {
                if (!this.stackBuf.push(ch)) {
                    this.emitOnError(errTooBig);
                    return data.subarray(idx); 
                }
            } else {
                if (ch == NL) {
                    const method = this.stackBuf.pop();
                    this.emitMethod(method.toString('ascii'));
                    return this.callNextState(idx, 
                        data, this.hdrLineDone);
                } else if (ch == NR) {
                    const method = this.stackBuf.pop();
                    this.emitMethod(method.toString('ascii'));
                    return this.callNextState(idx, 
                        data, this.hdrLineAlmostDone);
                } else {
                    this.emitOnError(errInvalReq);
                    return data.subarray(idx); 
                }
            }
        } while (idx < length)
        // EOF data
        return { length: 0 };
    }

    hdrLineAlmostDone(data) {
        let idx = 0;
        const ch = data[idx++];
        if (ch != NL) {
            this.emitOnError(errInvalFrame);
            return data.subarray(idx); 
        }

        return this.callNextState(idx, 
            data, this.hdrLineDone);
    }

    hdrLineDone(data) {
        let idx = 0;
        const { length } = data;
        const ch = data[idx++];
        if (ch == NR) {
            this.parseState = this.almostDoneState;
            const rc = data.subarray(idx);
            return (idx < length) ? 
                this.parseState(rc) : rc;
        } else if (ch == NL) {
            return this.callNextState(idx, 
                data, this.doneState);
        }

        if (!isPrintNoSpace(ch)) {
            this.emitOnError(errInvalFrame);
            return data.subarray(idx); 
        }

        if (!this.stackBuf.push(ch)) {
            this.emitOnError(errTooBig);
            return data.subarray(idx); 
        }

        return this.callNextState(idx, 
            data, this.hdrLineKey);
    }

    hdrLineKey(data) {
        let idx = 0;
        const { length } = data;
        do {
            let ch = data[idx++];
            if (ch == D2) {
                const headerKey = this.stackBuf.pop();
                this.emitHeaderKey(headerKey.toString('ascii'));
                return this.callNextState(idx, 
                    data, this.hdrLineVal);                
            } else {
                if (isPrintNoSpace(ch)) {
                    if (!this.stackBuf.push(ch)) {
                        this.emitOnError(errTooBig);
                        // FIXME: тоже не совсем вернно
                        // надо пропустить все до \0
                        // но вероятно соединение будет закрытор
                        return data.subarray(idx); 
                    }
                } else {
                    if (ch == NL) {
                        return this.callNextState(idx, 
                            data, this.hdrLineDone);                          
                    } else if (ch == NR) {
                        return this.callNextState(idx, 
                            data, this.hdrLineAlmostDone);                          
                    } else {
                        this.emitOnError(errInvalFrame);
                        // FIXME: тут надо какбы переходить на новый фрейм
                        // текущий не валидный
                        return data.subarray(idx); 
                    }
                }
            }
        } while (idx < length);
        // EOF data
        return { length: 0 };
    }

    hdrLineVal(data) {
        let idx = 0;
        const { length } = data;
        do {
            let ch = data[idx++];
            if (isPrint(ch)) {
                if (!this.stackBuf.push(ch)) {
                    this.emitOnError(errTooBig);
                    // FIXME: тоже не совсем вернно
                    // надо пропустить все до \0
                    // но вероятно соединение будет закрытор
                    return data.subarray(idx); 
                }
            } else {
                if (ch == NR) {
                    const headerVal = this.stackBuf.pop();
                    this.emitHeaderVal(headerVal.toString('ascii'));
                    return this.callNextState(idx, 
                        data, this.hdrLineAlmostDone);   
                } else if (ch == NL) {
                    const headerVal = this.stackBuf.pop();
                    this.emitHeaderVal(headerVal.toString('ascii'));
                    return this.callNextState(idx, 
                        data, this.hdrLineDone);   
                } else {
                    this.emitOnError(errInvalFrame);
                    // FIXME: тут надо какбы переходить на новый фрейм
                    // текущий не валидный
                    return data.subarray(idx); 
                }
            }
        } while (idx < length);
        // EOF data
        return { length: 0 };
    }

    almostDoneState(data) {
        let idx = 0;
        let ch = data[idx++];
        if (ch != NL) {
            this.emitOnError(errInvalFrame);
            // FIXME: тоже не совсем вернно
            // надо пропустить все до \0
            // но вероятно соединение будет закрытор
            return data.subarray(idx); 
        }
    
        return this.callNextState(idx, 
            data, this.doneState);
    }

    doneState(data) {
        let idx = 0;
        let ch = data[idx];
        let { parseState } = this;
        if (ch == EOF) {
            ++idx;
            parseState = this.startState;
            this.emitOnFrameEnd();
        } else {
            parseState = (this.contentLeft > 0) ? this.bodyRead : 
                this.bodyReadNoLength
        }
    
        return this.callNextState(idx, 
            data, parseState);
    }

    bodyRead(data) {
        let contentLength = this.contentLeft;
        let idx = Math.min(data.length, contentLength);
    
        if (idx > 0) {
            contentLength -= idx;
            this.contentLeft = contentLength;
            this.emitOnBody(data.subarray(0, idx));
        }

        let { parseState } = this;
        if (contentLength == 0) {
            parseState = this.frameEnd;
        }

        return this.callNextState(idx, 
            data, parseState);
    }

    bodyReadNoLength(data) {
        let idx = 0;
        const { length } = data;
        let { parseState } = this;
        do {
            let ch = data[idx++];
            if (ch == EOF) {
                // если достигли конца переходим к новому фрейму
                parseState = this.frameEnd;
                // вернемся назад чтобы обработать каллбек
                --idx;
                break;
            }
        } while (idx < length);
    
        if (idx) {
            this.emitOnBody(data.subarray(0, idx));
        }
    
        return this.callNextState(idx, 
            data, parseState);
    }

    frameEnd(data) {
        let idx = 0;
        this.parseState = this.startState;
        const ch = data[idx++];
        if (ch != EOF) {
            this.emitOnError(errInvalFrame);
        }

        // закончили
        this.emitOnFrameEnd();
    
        const rc = data.subarray(idx);
        return rc;
        // FIXME: длинна рекурсии
        return this.callNextState(idx, 
            data, this.startState);        
    }

    emitFrameStart() {
        this.onFrameStart();
    }

    addListener(eventName, listener) {
        switch (eventName) {
            case 'method':
                this.onMethod = (method) => {
                    this.emit('method', method);
                };
            break;
            case 'headerKey':
                this.onHeaderKey = (value) => {
                    this.emit('headerKey', value);
                };
            break;
            case 'headerVal':
                this.onHeaderVal = (value) => {
                    this.emit('headerVal', value);
                };
            break;
            case 'frameStart':
                this.onFrameStart = () => {
                    this.emit('frameStart');
                };
            break;
            case 'frameEnd':
                this.onFrameEnd = () => {
                    this.emit('frameEnd');
                };
            break;
            case 'body':
                this.onBody = (value) => {
                    this.emit('body', value);
                };
            break;
            case 'error':
                this.onError = (err) => {
                    this.emit('error', err);
                };
            break;
        }        
        super.addListener(eventName, listener);
    }
    
    on(eventName, listener) {
        switch (eventName) {
            case 'method':
                this.onMethod = (method) => {
                    this.emit('method', method);
                };
            break;
            case 'headerKey':
                this.onHeaderKey = (value) => {
                    this.emit('headerKey', value);
                };
            break;
            case 'headerVal':
                this.onHeaderVal = (value) => {
                    this.emit('headerVal', value);
                };
            break;
            case 'frameStart':
                this.onFrameStart = () => {
                    this.emit('frameStart');
                };
            break;
            case 'frameEnd':
                this.onFrameEnd = () => {
                    this.emit('frameEnd');
                };
            break;
            case 'body':
                this.onBody = (value) => {
                    this.emit('body', value);
                };
            break;
            case 'error':
                this.onError = (err) => {
                    this.emit('error', err);
                };
            break;
        }   
        super.on(eventName, listener);
    }

    once(eventName, listener) {
        throw new Error('not possible')
    }

    emitMethod(value) {
        this.onMethod(value);
    }

    emitHeaderKey(value) {
        // try find content-length
        if ((this.contentLength == 0) && isHeaderContentLength(value)) {
            this.isContentLength = true;
        }

        this.onHeaderKey(value)
    }

    emitHeaderVal(value) {
        // if current header is content-legth
        if (this.isContentLength) {                        
            this.isContentLength = false;
            this.contentLength = this.contentLeft = parseInt(value);            
        }
        
        this.onHeaderVal(value)
    }

    emitOnBody(value) {
        this.onBody(value);
    }

    emitOnFrameEnd() {
        this.onFrameEnd();
    }

    emitOnError(err) {
        this.onError(err);
    }

    parse(data) {
        while (data.length) {
            // now data become subarray of original data
            data = this.parseState(data);
        }
        return { length: 0 };
    }
}

const stompTok = new StompTok();

stompTok.onFrameStart = () => {
    //console.log('frame-start');
}

stompTok.onFrameEnd = () => {
    //console.log('frame-end');
}

let frameCount = 0;
stompTok.on('method', (text) => {
    //console.log('method:', text);
    ++frameCount;
});
stompTok.on('headerKey', (text) => {
    //console.log('headerKey:', text);
});
stompTok.on('headerVal', (text) => {
    //console.log('headerVal:', text);
});
stompTok.on('body', (buffer) => {
    //console.log('body:', buffer.toString('ascii'));
});
stompTok.on('error', err => {
    console.log('error:', err);
});

const buffer = Buffer.concat(
    [
        Buffer.from("CONNECTED\r\nversion:1.2\r\nsession:STOMP-PARSER-TEST\r\nserver:stomp-parser/1.0.0\r\n\r\n\0"),
        Buffer.from("MESSAGE\nid:0\ndestination:/queue/foo\nack:client\n\n\0"),
        Buffer.from("MESSAGE\r\nid:0\r\n\r\n\0"),
        Buffer.from("MESSAGE\r\nid:0\r\n\r\n\0"),
        Buffer.from("MESSAGE\nsubscription:0\nmessage-id:007\ndestination:/queue/a\ncontent-length:13\ncontent-type:text/plain\nmessage-error:false\n\nhello queue a\0"),
        Buffer.from("MESSAGE\r\nsubscription:0\r\nmessage-id:007\r\ndestination:/queue/a\r\ncontent-type:application/json\r\nmessage-no-content-length:true\r\n\r\n[1,2,3,4,5,6,7]\0\n\n\n\n\0"),
        Buffer.from("MESSAGE\r\nsubscription:0\r\nmessage-id:007\r\ndestination:/queue/a\r\ncontent-length:13\r\ncontent-type:text/plain\r\nmessage-error:false\r\n\r\nhello queue a\0"),
        Buffer.from("MESSAGE\r\nsubscription:0\r\nmessage-id:007\r\ndestination:/queue/a\r\ncontent-length:13\r\nmessage-error:false\r\n\r\nhello queue a\0"),
        Buffer.from("MESSAGE\r\nsubscription:0\r\nmessage-id:007\r\ndestination:/queue/a\r\n\r\nhello queue a\0"),
        Buffer.from("MESSAGE\r\nreceipt:77\r\n\r\n\0")
    ]);

const count = 1000000;
let i = 0;
for ( ; i < count; ++i)
{
    let pos = 0;
    let data = buffer.subarray(0);
    while (data.length) {
        data = stompTok.parse(data);
    }
}

console.log(frameCount);

// const strBuf = buffer.toString('ascii');
// for (let i = 0; i < strBuf.length; ++i) {
//     stompTok.parse(Buffer.from(strBuf[i]));
// }
