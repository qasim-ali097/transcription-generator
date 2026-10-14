# Generates sample speech files with the Windows built-in TTS voice (no downloads needed).
#   samples/speech.wav   ~13 s, short -> answered synchronously
#   samples/speech.mp3   same audio as MP3
#   samples/long.mp3     ~2.5 min (speech + pauses + 20 s of silence) -> async job, multiple chunks

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'samples'
New-Item -ItemType Directory -Force -Path $out | Out-Null

Add-Type -AssemblyName System.Speech

function Save-Speech([string]$text, [string]$path) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.Rate = 0
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($text)
  $synth.Dispose()
}

$part1 = 'Welcome to the transcription pipeline demo. This service accepts audio files in many formats, converts them to a standard format, and returns the text with timestamps for every segment.'
$part2 = 'Long recordings are split at natural pauses between sentences, so no word is ever cut in half. Each piece is transcribed separately, and the timestamps are shifted back onto the original timeline.'
$part3 = 'Silent sections are detected and skipped, which saves time and prevents the model from inventing text. Finally, the result can be exported as JSON, plain text, or subtitles.'

Save-Speech $part1 (Join-Path $out 'speech.wav')
Save-Speech $part2 (Join-Path $out 'part2.wav')
Save-Speech $part3 (Join-Path $out 'part3.wav')

$ffmpeg = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { 'ffmpeg' }
Push-Location $out
try {
  & $ffmpeg -hide_banner -loglevel error -y -i speech.wav -codec:a libmp3lame -q:a 4 speech.mp3

  # long.mp3 = (part1, pause, part2, pause, part3, pause) x 3, then 20 s of silence.
  & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'anullsrc=r=22050:cl=mono' -t 1.5 pause.wav
  & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'anullsrc=r=22050:cl=mono' -t 20 tail.wav
  $list = @()
  1..3 | ForEach-Object { $list += "file 'speech.wav'", "file 'pause.wav'", "file 'part2.wav'", "file 'pause.wav'", "file 'part3.wav'", "file 'pause.wav'" }
  $list += "file 'tail.wav'"
  $list | Set-Content -Encoding ascii concat.txt
  & $ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i concat.txt -ar 22050 -ac 1 -codec:a libmp3lame -q:a 4 long.mp3

  Remove-Item part2.wav, part3.wav, pause.wav, tail.wav, concat.txt
} finally {
  Pop-Location
}
Get-ChildItem $out | Select-Object Name, Length
