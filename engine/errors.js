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
  if (/encoder|nvenc|amf|qsv|libx264|codec/i.test(msg) && /fail|error|not found|cannot|unable|createcomponent/i.test(msg)) {
    out.category = 'ENCODER';
    out.title = "Recording couldn't start";
    out.message = 'Ordinary could not initialize the selected hardware encoder.';
    out.hint = 'We can try a safer recording configuration — set Encoder to Auto, or pick software x264.';
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
