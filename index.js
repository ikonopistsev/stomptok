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

const contentLengthHeader = 'content-length';
const isHeaderContentLength = (value) => {
    return contentLengthHeader == value;
}

class StompTok extends EventEmitter {
    constructor() {
        super();
        this.stackBuf = new ParserStack(2048);
        this.parseState = this.startState;
        // header 'content-length' data
        this.contentLength = 0;
        this.contentLeft = 0;
        const e = () => {};
        this.onFrameStart = e;
        this.onMethod = e;
        this.onHeaderKey = e;
        this.onHeaderVal = e;
        this.onBody = e;
        this.onFrameEnd = e;
        this.onError = e;
        this.isContentLength = false;
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
                this.emitOnError('inval_reqline');
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
        // завершаем парсинг достигли конца буфера
        return { length: 0 };
    }

    methodState(data) {
        let idx = 0;
        const { length } = data;
        do {
            let ch = data[idx++];
            if (isAsciiUpper(ch)) {
                if (!this.stackBuf.push(ch)) {
                    this.emitOnError('too_big');
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
                    this.emitOnError('inval_method');
                    return data.subarray(idx); 
                }
            }
        } while (idx < length)
        // завершаем парсинг достигли конца буфера
        return { length: 0 };
    }

    hdrLineAlmostDone(data) {
        let idx = 0;
        const ch = data[idx++];
        if (ch != NL) {
            this.emitOnError('inval_method');
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
            this.emitOnError('inval_reqline');
            return data.subarray(idx); 
        }

        if (!this.stackBuf.push(ch)) {
            this.emitOnError('too_big');
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
                        this.emitOnError('too_big');
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
                        this.emitOnError('inval_frame');
                        // FIXME: тут надо какбы переходить на новый фрейм
                        // текущий не валидный
                        return data.subarray(idx); 
                    }
                }
            }
        } while (idx < length);
        // завершаем парсинг достигли конца буфера
        return { length: 0 };
    }

    hdrLineVal(data) {
        let idx = 0;
        const { length } = data;
        do {
            let ch = data[idx++];
            if (isPrint(ch)) {
                if (!this.stackBuf.push(ch)) {
                    this.emitOnError('too_big');
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
                    this.emitOnError('inval_frame');
                    // FIXME: тут надо какбы переходить на новый фрейм
                    // текущий не валидный
                    return data.subarray(idx); 
                }
            }
        } while (idx < length);
        // завершаем парсинг достигли конца буфера
        return { length: 0 };
    }

    almostDoneState(data) {
        let idx = 0;
        let ch = data[idx++];
        if (ch != NL) {
            this.emitOnError('inval_reqline');
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
            this.emitOnError('inval_frame');
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
        if ((this.contentLength == 0) && isHeaderContentLength(value)) {
            this.isContentLength = true;
        }

        this.onHeaderKey(value)
    }

    emitHeaderVal(value) {
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
    }
}

const stompTok = new StompTok();

stompTok.onFrameStart = () => {
    console.log('frame-start');
}

stompTok.onFrameEnd = () => {
    console.log('frame-end');
}

stompTok.on('method', (text) => {
    console.log('method:', text);
});
stompTok.on('headerKey', (text) => {
    console.log('headerKey:', text);
});
stompTok.on('headerVal', (text) => {
    console.log('headerVal:', text);
});
stompTok.on('body', (buffer) => {
    console.log('body:', buffer.toString('ascii'));
});
stompTok.on('error', err => {
    console.log('error:', err);
});

const buffer = Buffer.from('CONNNECT\nmy:friend\nvery:funny\ncontent-length:3\n\nbad body\0CONNNECT\nmy:friend\nvery:funny\n\nbad body\0');
stompTok.parse(buffer);

const strBuf = buffer.toString('ascii');
for (let i = 0; i < strBuf.length; ++i) {
    stompTok.parse(Buffer.from(strBuf[i]));
}
