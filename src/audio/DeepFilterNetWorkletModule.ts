/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// DeepFilterNet3 AudioWorklet processor with sample-rate resampling.
//
// DeepFilterNet's model is trained for 48kHz audio. On many desktop/Windows
// WebViews the AudioContext runs at 44.1kHz (the device's native rate), which
// would otherwise make the model unusable. This worklet resamples the input
// stream to 48kHz before feeding the model, and resamples the output back to
// the AudioContext's native rate, so DeepFilterNet works on any platform.
//
// The WASM binary and ONNX model are passed in via `processorOptions` (fetched
// and compiled on the main thread by DeepFilterNetProcessor).

declare abstract class AudioWorkletProcessor {
  protected constructor(options?: AudioWorkletNodeOptions);
  public readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletProcessor,
): void;

// Available in the AudioWorkletGlobalScope.
declare const sampleRate: number;

const DEEPFILTERNET_SAMPLE_RATE = 48000;
const DEEPFILTERNET_WORKLET_NAME = "deepfilternet-processor";

// --- TextDecoder/TextEncoder shims (wasm-bindgen needs them) ----------------
if (typeof TextDecoder === "undefined") {
  (globalThis as unknown as { TextDecoder: unknown }).TextDecoder = class {
    public decode(bytes?: Uint8Array): string {
      if (!bytes) return "";
      const u8 =
        bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array((bytes as { buffer: ArrayBuffer }).buffer);
      let out = "";
      for (let i = 0; i < u8.length; ) {
        const c = u8[i++];
        if (c < 0x80) out += String.fromCharCode(c);
        else if (c < 0xe0)
          out += String.fromCharCode(((c & 0x1f) << 6) | (u8[i++] & 0x3f));
        else if (c < 0xf0)
          out += String.fromCharCode(
            ((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f),
          );
        else {
          const cp =
            (((c & 0x07) << 18) |
              ((u8[i++] & 0x3f) << 12) |
              ((u8[i++] & 0x3f) << 6) |
              (u8[i++] & 0x3f)) -
            0x10000;
          out += String.fromCharCode(
            0xd800 + (cp >> 10),
            0xdc00 + (cp & 0x3ff),
          );
        }
      }
      return out;
    }
  };
}
if (typeof TextEncoder === "undefined") {
  (globalThis as unknown as { TextEncoder: unknown }).TextEncoder = class {
    public encode(str: string): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c < 0xdc00) {
          const c2 = str.charCodeAt(++i);
          c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(
            0xf0 | (c >> 18),
            0x80 | ((c >> 12) & 0x3f),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f),
          );
        } else
          out.push(
            0xe0 | (c >> 12),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f),
          );
      }
      return new Uint8Array(out);
    }
  };
}

// --- wasm-bindgen glue (from deepfilternet3-noise-filter) --------------------
let wasm: any;
let WASM_VECTOR_LEN = 0;
let cachedFloat32ArrayMemory0: Float32Array | null = null;
let cachedUint8ArrayMemory0: Uint8Array | null = null;

function getFloat32ArrayMemory0(): Float32Array {
  if (
    cachedFloat32ArrayMemory0 === null ||
    cachedFloat32ArrayMemory0.byteLength === 0
  ) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
function getUint8ArrayMemory0(): Uint8Array {
  if (
    cachedUint8ArrayMemory0 === null ||
    cachedUint8ArrayMemory0.byteLength === 0
  ) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function getArrayF32FromWasm0(ptr: number, len: number): Float32Array {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU8FromWasm0(ptr: number, len: number): Uint8Array {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
function getStringFromWasm0(ptr: number, len: number): string {
  return decodeText(ptr >>> 0, len);
}
function addToExternrefTable0(obj: unknown): number {
  const idx = wasm.__externref_table_alloc_command_export();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function handleError(
  f: (...args: number[]) => unknown,
  args: number[],
): unknown {
  try {
    return f.apply(null, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store_command_export(idx);
  }
}
function passArray8ToWasm0(
  arg: Uint8Array,
  malloc: (n: number, a: number) => number,
): number {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function passArrayF32ToWasm0(
  arg: Float32Array,
  malloc: (n: number, a: number) => number,
): number {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getFloat32ArrayMemory0().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
let cachedTextDecoder = new TextDecoder("utf-8", {
  ignoreBOM: true,
  fatal: true,
});
cachedTextDecoder.decode();
let numBytesDecoded = 0;
function decodeText(ptr: number, len: number): string {
  numBytesDecoded += len;
  if (numBytesDecoded >= 2146435072) {
    cachedTextDecoder = new TextDecoder("utf-8", {
      ignoreBOM: true,
      fatal: true,
    });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(
    getUint8ArrayMemory0().subarray(ptr, ptr + len),
  );
}
function __wbg_get_imports(): WebAssembly.Imports {
  const import0 = {
    __wbg___wbindgen_throw_344f42d3211c4765: (
      arg0: number,
      arg1: number,
    ): void => {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_getRandomValues_cc7f052a444bb2ce: (
      arg0: number,
      arg1: number,
    ): void => {
      handleError(
        (a0: number, a1: number) => {
          globalThis.crypto.getRandomValues(getArrayU8FromWasm0(a0, a1));
        },
        [arg0, arg1],
      );
    },
    __wbg_new_from_slice_ddf8b82c4d6af38e: (
      arg0: number,
      arg1: number,
    ): Float32Array => {
      return new Float32Array(getArrayF32FromWasm0(arg0, arg1));
    },
    __wbindgen_init_externref_table: (): void => {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    },
  };
  return { "./df_bg.js": import0 } as unknown as WebAssembly.Imports;
}
function __wbg_finalize_init(
  instance: WebAssembly.Instance,
  _module: WebAssembly.Module,
): any {
  wasm = instance.exports;
  cachedFloat32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
function initSync(module: WebAssembly.Module): any {
  if (wasm !== undefined) return wasm;
  const imports = __wbg_get_imports();
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}
function df_create(model_bytes: Uint8Array, atten_lim: number): number {
  const ptr0 = passArray8ToWasm0(
    model_bytes,
    wasm.__wbindgen_malloc_command_export,
  );
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.df_create(ptr0, len0, atten_lim);
  return ret >>> 0;
}
function df_get_frame_length(st: number): number {
  const ret = wasm.df_get_frame_length(st);
  return ret >>> 0;
}
function df_process_frame(st: number, input: Float32Array): Float32Array {
  const ptr0 = passArrayF32ToWasm0(
    input,
    wasm.__wbindgen_malloc_command_export,
  );
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.df_process_frame(st, ptr0, len0);
  return ret;
}
function df_set_atten_lim(st: number, lim_db: number): void {
  wasm.df_set_atten_lim(st, lim_db);
}

// --- Linear-interpolation resampler ------------------------------------------
// Resamples a mono stream from `fromRate` to `toRate`. Keeps a fractional
// position so consecutive blocks stay phase-aligned.
class Resampler {
  private pos = 0;
  private readonly ratio: number;

  public constructor(fromRate: number, toRate: number) {
    this.ratio = fromRate / toRate;
  }

  public reset(): void {
    this.pos = 0;
  }

  /**
   * Resamples `input` and appends the result to `output`.
   */
  public process(input: Float32Array, output: Float32Array): void {
    const ratio = this.ratio;
    let pos = this.pos;
    let outIdx = 0;
    const inLen = input.length;
    while (pos < inLen - 1 && outIdx < output.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = input[i];
      const b = input[i + 1];
      output[outIdx++] = a + (b - a) * frac;
      pos += ratio;
    }
    this.pos = pos - inLen;
  }
}

// --- DeepFilterNet worklet processor -----------------------------------------
type WorkletMessage =
  | { type: "destroy" }
  | { type: "setSuppressionLevel"; value: number }
  | { type: "setBypass"; value: boolean };

class DeepFilterNetWorkletProcessor extends AudioWorkletProcessor {
  private dfModel: { handle: number; frameLength: number } | null = null;
  private isInitialized = false;
  private bypass = false;
  private destroyed = false;

  // Input ring buffer (native sample rate)
  private inputBuffer: Float32Array = new Float32Array(0);
  private inputWritePos = 0;
  private inputReadPos = 0;

  // 48kHz resampled buffer for the model
  private resampledBuffer: Float32Array = new Float32Array(0);
  private resampledWritePos = 0;
  private resampledReadPos = 0;

  // Output ring buffer (native sample rate)
  private outputBuffer: Float32Array = new Float32Array(0);
  private outputWritePos = 0;
  private outputReadPos = 0;

  private readonly sampleRate: number;
  private readonly upsampler: Resampler;
  private readonly downsampler: Resampler;
  private readonly tempFrame: Float32Array;

  public constructor(options?: AudioWorkletNodeOptions) {
    super();
    this.sampleRate = sampleRate;
    this.upsampler = new Resampler(this.sampleRate, DEEPFILTERNET_SAMPLE_RATE);
    this.downsampler = new Resampler(
      DEEPFILTERNET_SAMPLE_RATE,
      this.sampleRate,
    );
    this.tempFrame = new Float32Array(0);

    const processorOptions = (options?.processorOptions ?? {}) as {
      wasmModule?: WebAssembly.Module;
      modelBytes?: ArrayBuffer;
      suppressionLevel?: number;
    };
    const wasmModule = processorOptions.wasmModule;
    const modelBytes = processorOptions.modelBytes
      ? new Uint8Array(processorOptions.modelBytes)
      : new Uint8Array(0);
    const suppressionLevel = processorOptions.suppressionLevel ?? 50;

    try {
      if (!wasmModule) {
        throw new Error("DeepFilterNet WASM module not provided");
      }
      initSync(wasmModule);
      const handle = df_create(modelBytes, suppressionLevel);
      const frameLength = df_get_frame_length(handle);
      this.dfModel = { handle, frameLength };

      // Ring buffers sized for several frames.
      const inSize = Math.max(frameLength * 4, 8192);
      this.inputBuffer = new Float32Array(inSize);
      this.resampledBuffer = new Float32Array(frameLength * 4);
      this.outputBuffer = new Float32Array(inSize);
      this.tempFrame = new Float32Array(frameLength);

      this.isInitialized = true;
      this.port.onmessage = (event: MessageEvent<WorkletMessage>): void => {
        this.handleMessage(event.data);
      };
    } catch {
      this.isInitialized = false;
    }
  }

  private handleMessage(data: WorkletMessage): void {
    switch (data.type) {
      case "setSuppressionLevel":
        if (this.dfModel && typeof data.value === "number") {
          const level = Math.max(0, Math.min(100, Math.floor(data.value)));
          df_set_atten_lim(this.dfModel.handle, level);
        }
        break;
      case "setBypass":
        this.bypass = Boolean(data.value);
        break;
      case "destroy":
        this.destroyed = true;
        break;
    }
  }

  private getInputAvailable(): number {
    return (
      (this.inputWritePos - this.inputReadPos + this.inputBuffer.length) %
      this.inputBuffer.length
    );
  }
  private getResampledAvailable(): number {
    return (
      (this.resampledWritePos -
        this.resampledReadPos +
        this.resampledBuffer.length) %
      this.resampledBuffer.length
    );
  }
  private getOutputAvailable(): number {
    return (
      (this.outputWritePos - this.outputReadPos + this.outputBuffer.length) %
      this.outputBuffer.length
    );
  }

  public process(
    inputList: Float32Array[][],
    outputList: Float32Array[][],
  ): boolean {
    if (this.destroyed) return false;

    const input = inputList[0]?.[0];
    if (!input) return true;

    const sourceLimit = Math.min(inputList.length, outputList.length);

    // Passthrough when not initialized or bypassed.
    if (!this.isInitialized || !this.dfModel || this.bypass) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        for (let channelNum = 0; channelNum < output.length; channelNum++) {
          output[channelNum].set(input);
        }
      }
      return true;
    }

    // Write input to the native-rate ring buffer.
    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputWritePos] = input[i];
      this.inputWritePos = (this.inputWritePos + 1) % this.inputBuffer.length;
    }

    // Resample available native-rate input up to 48kHz.
    const avail = this.getInputAvailable();
    if (avail > 0) {
      // Extract a contiguous chunk for resampling.
      const chunk = new Float32Array(avail);
      for (let i = 0; i < avail; i++) {
        chunk[i] = this.inputBuffer[this.inputReadPos];
        this.inputReadPos = (this.inputReadPos + 1) % this.inputBuffer.length;
      }
      const resampled = new Float32Array(
        Math.ceil(avail * (DEEPFILTERNET_SAMPLE_RATE / this.sampleRate)) + 2,
      );
      this.upsampler.process(chunk, resampled);
      for (let i = 0; i < resampled.length; i++) {
        this.resampledBuffer[this.resampledWritePos] = resampled[i];
        this.resampledWritePos =
          (this.resampledWritePos + 1) % this.resampledBuffer.length;
      }
    }

    // Process complete 48kHz frames through the model.
    const frameLength = this.dfModel.frameLength;
    while (this.getResampledAvailable() >= frameLength) {
      for (let i = 0; i < frameLength; i++) {
        this.tempFrame[i] = this.resampledBuffer[this.resampledReadPos];
        this.resampledReadPos =
          (this.resampledReadPos + 1) % this.resampledBuffer.length;
      }
      const processed = df_process_frame(this.dfModel.handle, this.tempFrame);
      // Downsample the processed 48kHz frame back to the native rate.
      const down = new Float32Array(
        Math.ceil(
          processed.length * (this.sampleRate / DEEPFILTERNET_SAMPLE_RATE),
        ) + 2,
      );
      this.downsampler.process(processed, down);
      for (let i = 0; i < down.length; i++) {
        this.outputBuffer[this.outputWritePos] = down[i];
        this.outputWritePos =
          (this.outputWritePos + 1) % this.outputBuffer.length;
      }
    }

    // Write output (native rate) to the output channels.
    const outputAvailable = this.getOutputAvailable();
    const blockSize = outputList[0]?.[0]?.length ?? 128;
    if (outputAvailable >= blockSize) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        for (let channelNum = 0; channelNum < output.length; channelNum++) {
          const outputChannel = output[channelNum];
          let readPos = this.outputReadPos;
          for (let i = 0; i < blockSize; i++) {
            outputChannel[i] = this.outputBuffer[readPos];
            readPos = (readPos + 1) % this.outputBuffer.length;
          }
        }
      }
      this.outputReadPos =
        (this.outputReadPos + blockSize) % this.outputBuffer.length;
    }

    return true;
  }
}

registerProcessor(DEEPFILTERNET_WORKLET_NAME, DeepFilterNetWorkletProcessor);
