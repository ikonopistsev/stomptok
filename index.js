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
                this.emit('error', 'inval_reqline');
                return data.subarray(idx);
            }

            this.emitFrameStart();
            this.stackBuf.clear();
            this.stackBuf.push(ch);
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
                    this.emit('error', 'too_big');
                    return data.subarray(idx); 
                }
            } else {
                const rc = data.subarray(idx);
                if (ch == NL) {
                    const method = this.stackBuf.pop();
                    super.emitMethod(method);
                    this.parseState = this.hdrLineDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else if (ch == NR) {
                    const method = this.stackBuf.pop();
                    super.emit('method', method);
                    this.parseState = this.hdrLineAlmostDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else {
                    super.emit('error', 'inval_method');
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
            super.emit('error', 'inval_method');
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
            super.emit('error', 'inval_reqline');
            return data.subarray(idx); 
        }

        if (!this.stackBuf.push(ch)) {
            this.emit('error', 'too_big');
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
                this.emit('headerKey', headerKey);
                this.parseState = this.hdrLineVal;
                const rc = data.subarray(idx);
                return (idx < data.length) ? 
                    this.parseState(rc) : rc;
            } else {
                if (isPrintNoSpace(ch)) {
                    if (!this.stackBuf.push(ch)) {
                        this.emit('error', 'too_big');
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
                        this.emit('error', 'inval_frame');
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
                    this.emit('error', 'too_big');
                    // FIXME: тоже не совсем вернно
                    // надо пропустить все до \0
                    // но вероятно соединение будет закрытор
                    return data.subarray(idx); 
                }
            } else {
                const rc = data.subarray(idx);
                if (ch == NR) {
                    const headerVal = this.stackBuf.pop();
                    this.emit('headerVal', headerVal);
                    this.parseState = this.hdrLineAlmostDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else if (ch == NL) {
                    const headerVal = this.stackBuf.pop();
                    this.emit('headerVal', headerVal);
                    this.parseState = this.hdrLineDone;
                    return (idx < data.length) ? 
                        this.parseState(rc) : rc;
                } else {
                    this.emit('error', 'inval_frame');
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
            this.emit('error', 'inval_reqline');
            // FIXME: тоже не совсем вернно
            // надо пропустить все до \0
            // но вероятно соединение будет закрытор
            return data.subarray(idx); 
        }
    
        this.parseState = this.doneState;
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
            if (hook.content_left() > 0)
            {
                // выбираем как будем читать боди
                state_ = &parser::body_read;
    
                if (curr < end)
                    return body_read(hook, curr, end);
            }
            else
            {
                // выбираем как будем читать боди
                state_ = &parser::body_read_no_length;
    
                if (curr < end)
                    return body_read_no_length(hook, curr, end);
            }
        }
    
        return (idx < data.length) ? 
            this.parseState(rc) : rc;
    }

    emitFrameStart() {
        this.onFrameStart();
    }

    addListener(eventName, listener) {
        super.addListener(eventName, listener);
    }
    
    on(eventName, listener) {
        super.on(eventName, listener);
    }

    once(eventName, listener) {
        super.once(eventName, listener);
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
stompTok.on('error', err => {
    console.log('error', err);
});
stompTok.parse(Buffer.from('CONNNECT\nmy:friend\nvery:funny\n\n'));
