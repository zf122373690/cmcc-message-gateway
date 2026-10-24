/** opencore-amr emscripten glue 的最小类型（本地副本 amr-glue.js） */
export interface EmscriptenModuleArg {
  instantiateWasm?: (
    imports: Record<string, unknown>,
    receiveInstance: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => unknown;
  [key: string]: unknown;
}

export default function createAMR(
  moduleArg?: EmscriptenModuleArg,
): Promise<unknown>;
