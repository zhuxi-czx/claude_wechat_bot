declare module "qrcode-terminal" {
  interface Options {
    small?: boolean;
  }
  const mod: {
    generate(url: string, opts: Options, callback: (qr: string) => void): void;
  };
  export default mod;
}
