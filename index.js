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

const NL = 10;
const NR = 13;
const EOF = 0;
const D2 = 58;

const isAsciiUpper = (ch) => {
    return (65 <= ch) && (ch <= 90);
}

const isPrintNoSpace = (ch) => {
    return (32 < ch) && (ch <= 126);
}

const isPrint = (ch) => {
    return (32 <= ch) && (ch <= 126);
}

class StompTok extends EventEmitter {
    constructor() {
        super();
        this.stackBuf = new ParserStack(32);
        this.parseState = this.startState;
        // header 'content-length' data
        this.contentLength = 0;
        this.contentLeft = 0;
        const empty = () => {};
        this.onFrameStart = empty;
        this.onMethod = empty;
        this.onHeaderKey = empty;
        this.onHeaderVal = empty;
        this.onBody = empty;
        this.onFrameEnd = empty;
        this.onError = empty;
        this.isContentLength = false;
    }

    startState(data) {
        let idx = 0;   
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
            this.parseState = this.methodState;
            const rc = data.subarray(idx);
            return (idx < data.length) ? 
                this.parseState(rc) : rc;
        } while (idx < data.length);
        // завершаем парсинг достигли конца буфера
        return { length: 0 };
    }

    methodState(data) {
        let idx = 0;
        do {
            let ch = data[idx++];
            if (isAsciiUpper(ch)) {
                if (!this.stackBuf.push(ch)) {
                    this.emitOnError('too_big');
                    return data.subarray(idx); 
                }
            } else {
                const rc = data.subarray(idx);
                if (ch == NL) {
                    const method = this.stackBuf.pop();
                    this.emitMethod(method);
                    this.parseState = this.hdrLineDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else if (ch == NR) {
                    const method = this.stackBuf.pop();
                    this.emitMethod(method);
                    this.parseState = this.hdrLineAlmostDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else {
                    this.emitOnError('inval_method');
                    return rc; 
                }
            }
        } while (idx < data.length)
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

        this.parseState = this.hdrLineDone;
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    hdrLineDone(data) {
        let idx = 0;
        const ch = data[idx++];
        if (ch == NR) {
            this.parseState = this.almostDoneState;
            const rc = data.subarray(idx);
            return (idx < data.length) ? 
                this.parseState(rc) : rc;
        } else if (ch == NL) {
            this.parseState = this.doneState;
            const rc = data.subarray(idx);
            return (idx < data.length) ? 
                this.parseState(rc) : rc;
        }

        if (!isPrintNoSpace(ch)) {
            this.emitOnError('inval_reqline');
            return data.subarray(idx); 
        }

        if (!this.stackBuf.push(ch)) {
            this.emitOnError('too_big');
            return data.subarray(idx); 
        }

        this.parseState = this.hdrLineKey;
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    hdrLineKey(data) {
        let idx = 0;
        do {
            let ch = data[idx++];
            if (ch == D2) {
                const headerKey = this.stackBuf.pop();
                this.emitHeaderKey(headerKey);
                this.parseState = this.hdrLineVal;
                const rc = data.subarray(idx);
                return (idx < data.length) ? 
                    this.parseState(rc) : rc;
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
                    const rc = data.subarray(idx);
                    if (ch == NL) {
                        this.parseState = this.hdrLineDone;
                        return (idx < data.length) ? 
                            this.parseState(rc) : rc;
                    } else if (ch == NR) {
                        this.parseState = this.hdrLineAlmostDone;
                        return (idx < data.length) ? 
                            this.parseState(rc) : rc;
                    } else {
                        this.emitOnError('inval_frame');
                        // FIXME: тут надо какбы переходить на новый фрейм
                        // текущий не валидный
                        return data.subarray(idx); 
                    }
                }
            }
        } while (idx < data.length);
        // завершаем парсинг достигли конца буфера
        return { length: 0 };
    }

    hdrLineVal(data) {
        let idx = 0;   
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
                const rc = data.subarray(idx);
                if (ch == NR) {
                    const headerVal = this.stackBuf.pop();
                    this.emitHeaderVal(headerVal);
                    this.parseState = this.hdrLineAlmostDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else if (ch == NL) {
                    const headerVal = this.stackBuf.pop();
                    this.emitHeaderVal(headerVal);
                    this.parseState = this.hdrLineDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else {
                    this.emitOnError('inval_frame');
                    // FIXME: тут надо какбы переходить на новый фрейм
                    // текущий не валидный
                    return data.subarray(idx); 
                }
            }
        } while (idx < data.length);
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
    
        this.parseState = this.doneState;
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    doneState(data) {
        let idx = 0;
        let ch = data[idx];
        if (ch == EOF) {
            ++idx;
            this.parseState = this.startState;
            this.emitOnFrameEnd();
        } else {
            if (this.contentLeft > 0) {
                this.parseState = this.bodyRead;
            } else  {
                this.parseState = this.bodyReadNoLength;
            }
        }
    
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    bodyRead(data) {
        let contentLength = this.contentLeft;
        let idx = Math.min(data.length, contentLength);
    
        if (idx > 0) {
            contentLength -= idx;
            this.contentLeft = contentLength;
            this.emitOnBody(data.subarray(0, idx));
        }

        if (contentLength == 0) {
            this.parseState = this.frameEnd;
        }

        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    bodyReadNoLength(data) {
        let idx = 0;
        do {
            let ch = data[idx++];
            if (ch == EOF) {
                // если достигли конца переходим к новому фрейму
                this.parseState = this.frameEnd;
                // вернемся назад чтобы обработать каллбек
                --idx;
                break;
            }
        } while (idx < data.length);
    
        if (idx) {
            this.emitOnBody(data.subarray(0, idx));
        }
    
        const rc = data.subarray(idx);
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
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
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    emitFrameStart() {
        this.onFrameStart();
    }

    addListener(eventName, listener) {
        switch (eventName) {
            case 'method':
                this.emitMethod = (method) => {
                    this.emit('method', method);
                };
            break;
            case 'headerKey':
                this.emitHeaderKey = (value) => {
                    this.emit('headerKey', value);
                };
            break;
            case 'headerVal':
                this.emitHeaderVal = (value) => {
                    this.emit('headerVal', value);
                };
            break;
            case 'frameStart':
                this.emitFrameStart = () => {
                    this.emit('frameStart');
                };
            break;
            case 'frameEnd':
                this.emitFrameEnd = () => {
                    this.emit('frameEnd');
                };
            break;
            case 'body':
                this.emitOnBody = (value)=> {
                    this.emit('body', value);
                };
            break;
            case 'error':
                this.emitOnError = (err)=> {
                    this.emit('error', err);
                };
            break;
        }        
        super.addListener(eventName, listener);
    }
    
    on(eventName, listener) {
        switch (eventName) {
            case 'method':
                this.emitMethod = (method) => {
                    this.emit('method', method);
                };
            break;
            case 'headerKey':
                this.emitHeaderKey = (value) => {
                    this.emit('headerKey', value);
                };
            break;
            case 'headerVal':
                this.emitHeaderVal = (value) => {
                    this.emit('headerVal', value);
                };
            break;
            case 'frameStart':
                this.emitFrameStart = () => {
                    this.emit('frameStart');
                };
            break;
            case 'frameEnd':
                this.emitFrameEnd = () => {
                    this.emit('frameEnd');
                };
            break;
            case 'body':
                this.emitOnBody = (value)=> {
                    this.emit('body', value);
                };
            break;
            case 'error':
                this.emitOnError = (err)=> {
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
        this.onHeaderKey(value)
    }

    emitHeaderVal(value) {
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

stompTok.on('method', (name) => {
    console.log('method', name.toString('ascii'));
});
stompTok.on('headerKey', (value) => {
    console.log('headerKey', value.toString('ascii'));
});
stompTok.on('headerVal', (value) => {
    console.log('headerVal', value.toString('ascii'));
});
stompTok.on('body', (value) => {
    console.log('headerVal', value.toString('ascii'));
});
stompTok.on('error', err => {
    console.log('error', err);
});

stompTok.parse(Buffer.from('CONNNECT\nmy:friend\nvery:funny\n\nbad body\0'));
