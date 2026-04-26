declare module 'whisper-node' {
  interface TranscriptLine {
    start: string;
    end: string;
    speech: string;
  }
  interface WhisperOptions {
    modelName?: string;
    modelPath?: string;
    whisperOptions?: { word_timestamps?: boolean };
  }
  function whisper(
    filePath: string,
    options?: WhisperOptions,
  ): Promise<TranscriptLine[]>;
  export default whisper;
}
