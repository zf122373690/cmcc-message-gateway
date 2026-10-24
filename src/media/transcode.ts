/**
 * AMR 录音转码模块。
 *
 * 背景：T3 来电录音为 AMR-NB（#!AMR\n 魔数），中国移动新消息平台按文件实际
 * 内容识别媒体类型，AMR 不在其音频识别列表（仅 .mp3/.wav/.aac/.m4a/.ogg），
 * 会被降级成文件卡片而非语音气泡。因此在推送前把 AMR 解码并重编码为 MP3
 * （8kHz 单声道 24kbps，MPEG-2 Layer III），再以 audio/mpeg 上传发送。
 *
 * 实现说明：
 * - 解码用 opencore-amr 编译的 WASM（amr.wasm，Apache-2.0）。Cloudflare
 *   Workers 禁止运行时编译 WASM（"Wasm code generation disallowed by
 *   embedder"），因此 amr.wasm 经 wrangler [[rules]] type="CompiledWasm"
 *   在部署时预编译，导入即为 WebAssembly.Module；再通过 emscripten 的
 *   instantiateWasm 钩子把预编译模块注入 glue（amr-glue.js 为
 *   @audio/decode-amr 的 glue 本地副本，AMRDecoder 类移植自其 decode-amr.js）。
 * - 编码用 @breezystack/lamejs（纯 JS MP3 编码器）。
 */

// 部署时预编译的 WASM 模块（wrangler rules: CompiledWasm）
import amrWasmModule from "./amr.wasm";
// opencore-amr 的 emscripten glue（本地副本，支持 instantiateWasm 钩子）
import createAMR from "./amr-glue.js";
// 纯 JS MP3 编码器
import { Mp3Encoder } from "@breezystack/lamejs";

/** "#!AMR\n" 魔数（AMR-NB 单文件格式，RFC 3267） */
const AMR_NB_MAGIC = [0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a];

/** 按文件内容判断是否为 AMR（单文件格式） */
export function isAmrBytes(bytes: Uint8Array): boolean {
  if (bytes.length < AMR_NB_MAGIC.length) return false;
  for (let i = 0; i < AMR_NB_MAGIC.length; i += 1) {
    if (bytes[i] !== AMR_NB_MAGIC[i]) return false;
  }
  return true;
}

/** 按文件名/扩展名判断是否为 AMR */
export function isAmrFileName(name: string): boolean {
  return /\.amr$/i.test(String(name || ""));
}

export interface AmrToMp3Result {
  mp3: Uint8Array | null;
  error?: string;
}

// ---------------------------------------------------------------- WASM 解码器

interface AmrWasmModule {
  _amr_nb_create(): number;
  _amr_nb_decode(handle: number, dataPtr: number, size: number): number;
  _amr_nb_output(): number;
  _amr_nb_close(handle: number): void;
  _amr_wb_create(): number;
  _amr_wb_decode(handle: number, dataPtr: number, size: number): number;
  _amr_wb_output(): number;
  _amr_wb_close(handle: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
}

/**
 * 模块级缓存：emscripten glue + WASM 实例化代价高（线上实测每次请求数秒），
 * 每个 isolate 只做一次，后续请求复用。实例化失败时清掉缓存允许重试。
 */
let amrModulePromise: Promise<AmrWasmModule> | null = null;

function getAmrModule(): Promise<AmrWasmModule> {
  if (!amrModulePromise) {
    amrModulePromise = (createAMR({
      instantiateWasm: (
        imports: Record<string, unknown>,
        receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) => {
        const instance = new WebAssembly.Instance(
          amrWasmModule,
          imports as WebAssembly.Imports,
        );
        receiveInstance(instance, amrWasmModule);
        return instance.exports;
      },
    }) as Promise<AmrWasmModule>).catch((error) => {
      amrModulePromise = null;
      throw error;
    });
  }
  return amrModulePromise;
}

/** AMR-NB 帧长（含 1 字节头），按 mode 0-15 索引 */
const NB_SIZES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 6, 6, 6, 1, 1, 1, 1];
/** AMR-WB 帧长（含 1 字节头），按 mode 0-15 索引 */
const WB_SIZES = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 1, 1, 1, 1, 1, 1];

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 });

interface DecodedAudio {
  channelData: Float32Array[];
  sampleRate: number;
}

/**
 * 用（缓存的）预编译 WASM 实例化 glue，返回 AMR 解码器。
 * 移植自 @audio/decode-amr 的 AMRDecoder（Apache-2.0）。
 */
async function createAmrDecoder(): Promise<{
  decode(data: Uint8Array): DecodedAudio;
  flush(): DecodedAudio;
  free(): void;
}> {
  const mod = await getAmrModule();
  return new AmrDecoder(mod);
}

class AmrDecoder {
  private readonly m: AmrWasmModule;
  private done = false;
  private ptr = 0;
  private cap = 0;
  private isWB: boolean | null = null;
  private handle: number | null = null;
  private left: Uint8Array | null = null;
  private sampleRate = 0;

  constructor(mod: AmrWasmModule) {
    this.m = mod;
  }

  decode(data: Uint8Array): DecodedAudio {
    if (this.done) throw new Error("Decoder already freed");
    if (!data || data.byteLength === 0) return EMPTY;

    let buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.left) {
      const merged = new Uint8Array(this.left.length + buf.length);
      merged.set(this.left);
      merged.set(buf, this.left.length);
      buf = merged;
      this.left = null;
    }

    let off = 0;

    // 首帧识别 AMR-NB（#!AMR\n）还是 AMR-WB（#!AMR-WB\n）
    if (this.isWB === null) {
      if (buf.length < 9) {
        this.left = buf.slice();
        return EMPTY;
      }
      if (
        buf[0] === 0x23 &&
        buf[1] === 0x21 &&
        buf[2] === 0x41 &&
        buf[3] === 0x4d &&
        buf[4] === 0x52
      ) {
        if (
          buf.length > 8 &&
          buf[5] === 0x2d &&
          buf[6] === 0x57 &&
          buf[7] === 0x42 &&
          buf[8] === 0x0a
        ) {
          this.isWB = true;
          off = 9;
        } else if (buf[5] === 0x0a) {
          this.isWB = false;
          off = 6;
        }
      }
      if (this.isWB === null) return EMPTY;
      this.sampleRate = this.isWB ? 16000 : 8000;
      this.handle = this.isWB ? this.m._amr_wb_create() : this.m._amr_nb_create();
    }

    const sizes = this.isWB ? WB_SIZES : NB_SIZES;
    const chunks: Float32Array[] = [];

    while (off < buf.length) {
      const mode = (buf[off] >> 3) & 0x0f;
      const frameSize = sizes[mode];
      if (!frameSize || off + frameSize > buf.length) break;

      const ptr = this.alloc(frameSize);
      this.m.HEAPU8.set(buf.subarray(off, off + frameSize), ptr);

      const n = this.isWB
        ? this.m._amr_wb_decode(this.handle!, ptr, frameSize)
        : this.m._amr_nb_decode(this.handle!, ptr, frameSize);

      const outPtr = this.isWB
        ? this.m._amr_wb_output()
        : this.m._amr_nb_output();
      chunks.push(new Float32Array(this.m.HEAPF32.buffer, outPtr, n).slice());

      off += frameSize;
    }

    if (off < buf.length) this.left = buf.subarray(off).slice();
    if (chunks.length === 0) return EMPTY;

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return { channelData: [out], sampleRate: this.sampleRate };
  }

  flush(): DecodedAudio {
    this.left = null;
    return EMPTY;
  }

  free(): void {
    if (this.done) return;
    this.done = true;
    if (this.handle != null) {
      if (this.isWB) this.m._amr_wb_close(this.handle);
      else this.m._amr_nb_close(this.handle);
      this.handle = null;
    }
    if (this.ptr) {
      this.m._free(this.ptr);
      this.ptr = 0;
      this.cap = 0;
    }
    this.left = null;
  }

  private alloc(len: number): number {
    if (len > this.cap) {
      if (this.ptr) this.m._free(this.ptr);
      this.cap = len;
      this.ptr = this.m._malloc(len);
    }
    return this.ptr;
  }
}

// ---------------------------------------------------------------- 转码入口

/**
 * AMR → MP3。
 *
 * @param amr AMR 文件字节（带 #!AMR\n 头的单文件格式）
 * @returns { mp3, error }：mp3 为转码结果；失败时 mp3=null 且 error 带原因
 *          （调用方回退原样上传，不阻塞推送）
 */
export async function amrToMp3(amr: Uint8Array): Promise<AmrToMp3Result> {
  if (!isAmrBytes(amr)) return { mp3: null, error: "not-amr" };

  let decoder: Awaited<ReturnType<typeof createAmrDecoder>> | null = null;
  try {
    decoder = await createAmrDecoder();
    const audio = decoder.decode(amr);
    const pcm = audio.channelData?.[0];
    if (!pcm || pcm.length === 0 || !audio.sampleRate) {
      return { mp3: null, error: "decode-empty" };
    }

    // Float32 [-1,1] → Int16 PCM
    const pcm16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const encoder = new Mp3Encoder(1, audio.sampleRate, 24);
    const chunks: Uint8Array[] = [];
    const blockSize = 1152; // MPEG Layer III 每帧样本数
    for (let i = 0; i < pcm16.length; i += blockSize) {
      const encoded = encoder.encodeBuffer(pcm16.subarray(i, i + blockSize));
      if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(new Uint8Array(tail));

    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    if (total === 0) return { mp3: null, error: "encode-empty" };

    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return { mp3: out };
  } catch (error) {
    return {
      mp3: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      decoder?.free();
    } catch {
      // ignore
    }
  }
}

export interface TranscodeResult {
  /** 最终要上传的文件（转码成功为 MP3，否则为原文件） */
  file: File;
  /** 是否发生了 AMR→MP3 转码 */
  transcoded: boolean;
  /** 输入是否命中 AMR（内容或文件名） */
  amrDetected: boolean;
  /** 转码失败原因（成功时为空） */
  reason?: string;
}

/**
 * 若输入是 AMR 录音，转码为 MP3 并包装成 File；否则原样返回。
 *
 * @param file 上传的文件（T3 固定 filename=record.amr）
 */
export async function transcodeAmrFile(file: File): Promise<TranscodeResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return {
      file,
      transcoded: false,
      amrDetected: false,
      reason: `read-failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // 内容或文件名任一命中 AMR 才尝试转码（内容优先，防误判）
  const amrDetected = isAmrBytes(bytes) || isAmrFileName(file.name);
  if (!amrDetected) {
    return { file, transcoded: false, amrDetected: false };
  }

  const { mp3, error } = await amrToMp3(bytes);
  if (!mp3 || mp3.length === 0) {
    return { file, transcoded: false, amrDetected: true, reason: error };
  }

  const baseName = (file.name || "record").replace(/\.amr$/i, "") || "record";
  // mp3 为 new Uint8Array(total) 精确分配，buffer 即完整数据
  const mp3File = new File([mp3.buffer as ArrayBuffer], `${baseName}.mp3`, {
    type: "audio/mpeg",
  });
  return { file: mp3File, transcoded: true, amrDetected: true };
}
