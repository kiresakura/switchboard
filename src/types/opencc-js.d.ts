declare module "opencc-js" {
  export type ConverterOptions = {
    from: "cn" | "hk" | "tw" | "twp" | "jp";
    to: "cn" | "hk" | "tw" | "twp" | "jp";
  };
  export function Converter(opts: ConverterOptions): (text: string) => string;
}
