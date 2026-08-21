'use strict';

function friendlyError(raw, category) {
  const detail = String((raw && raw.message) || raw || '').trim();
  const msg = detail.toLowerCase();

  const out = {
    category: category || 'SYSTEM',
    title: 'Something went wrong',
    message: 'Ordinary hit a problem and stopped what it was doing.',
    hint: 'Open diagnostics.log next to the app settings if it keeps happening.',
    detail: detail.slice(0, 500)
  };

  if (/already recording|already starting|busy/i.test(detail)) {
    out.title = 'Already recording';
    out.message = 'A recording is already in progress.';
    out.hint = 'Press Stop, then start again.';
    return out;
  }
  if (/already stopping|not recording/i.test(detail)) {
    out.title = 'Nothing to stop';
    out.message = 'Ordinary is not recording right now.';
    out.hint = '';
    return out;
  }
  if (/ffmpeg not found|ffmpeg.exe/i.test(msg)) {
    out.category = 'ENCODER';
    out.title = "Recording couldn't start";
    out.message = 'Ordinary could not find FFmpeg.';
    out.hint = 'Put ffmpeg.exe in the ffmpeg folder, or add FFmpeg to PATH.';
    return out;
  }
  if (/option not found|non-existent option|error opening input/i.test(msg)) {
    out.category = 'CAPTURE';
    out.title = "Recording couldn't start";
    out.message = 'Screen capture settings are incompatible with this FFmpeg build.';
    out.hint = 'Ordinary will fall back automatically. If it keeps failing, set Encoder to Software x264.';
    return out;
  }
  if (/ffmpeg exit|exited unexpectedly|quit while recording/i.test(msg) && detail.length < 40) {
    out.category = 'ENCODER';
    out.title = "Recording stopped";
    out.message = 'The encoder quit unexpectedly.';
    out.hint = 'Try Software x264, turn Instant Replay off briefly, then start again.';
    return out;
  }
  // Do NOT match healthy libx264 end-of-encode banners ("[libx264 @ ...] kb/s:...")
  if (
    /nvenc|amf|qsv|h264_amf|hevc_amf|h264_nvenc|hevc_nvenc|h264_qsv|hevc_qsv/i.test(msg) &&
    /fail|error|not found|cannot|unable|createcomponent|encoder not found|failed to open/i.test(msg)
  ) {
    out.category = 'ENCODER';
    out.title = "Recording couldn't start";
    out.message = 'Ordinary could not initialize the selected hardware encoder.';
    out.hint = 'Set Encoder to Software x264 in Settings, then try again.';
    return out;
  }
  if (/libx264/i.test(msg) && /fail|error initializing|failed to open|encoder not found/i.test(msg) && !/kb\/s:/i.test(msg)) {
    out.category = 'ENCODER';
    out.title = "Recording couldn't start";
    out.message = 'Software encoder failed to start.';
    out.hint = 'Restart Ordinary and try again. If it keeps failing, free some RAM/CPU.';
    return out;
  }
  if (/ddagrab|desktop duplication|acquireNextFrame|887a0026|887a0027|selected output not supported/i.test(msg)) {
    out.category = 'CAPTURE';
    out.title = 'Capture lost the display';
    out.message = 'Desktop duplication was blocked — often an exclusive-fullscreen game.';
    out.hint = 'Ordinary will try game capture. Keep Exclusive Fullscreen on, and press Record while the game is in front.';
    return out;
  }
  if (/no video was captured|empty\/too small|0 bytes/i.test(msg)) {
    out.category = 'CAPTURE';
    out.title = 'Nothing usable was saved';
    out.message = 'The recording file had no video.';
    out.hint = 'Start the game first, then press the record hotkey while that game is in front.';
    return out;
  }
  if (/disk|enospc|space low|no space/i.test(msg)) {
    out.category = 'STORAGE';
    out.title = 'Disk space is too low';
    out.message = 'Ordinary stopped so the drive does not fill up.';
    out.hint = 'Free some space or lower Disk Reserve in Settings.';
    return out;
  }
  if (/audio|wasapi|directshow|loopback/i.test(msg) && /fail|error|not found|dropped/i.test(msg)) {
    out.category = 'AUDIO';
    out.title = 'Audio source changed';
    out.message = 'Game audio may be silent, but the recording can continue.';
    out.hint = 'Press Test Audio in Settings while something is playing.';
    return out;
  }
  if (/replay buffer is empty|instant replay is not active/i.test(msg)) {
    out.category = 'REPLAY';
    out.title = 'No replay clip yet';
    out.message = 'The replay buffer does not have enough footage.';
    out.hint = 'Leave Instant Replay ON for about 15–30 seconds, then try again.';
    return out;
  }
  if (category === 'RECOVERY' || /recover/i.test(msg)) {
    out.category = 'RECOVERY';
    out.title = 'Could not recover last recording';
    out.message = 'Ordinary found leftover files but could not finish them.';
    out.hint = 'The original .mkv / .webm was left on disk so nothing is deleted.';
    return out;
  }
  return out;
}

function userFacing(raw, category) {
  const f = friendlyError(raw, category);
  return f.hint ? `${f.message} ${f.hint}` : f.message;
}

module.exports = { friendlyError, userFacing };
