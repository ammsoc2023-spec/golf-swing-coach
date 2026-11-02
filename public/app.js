(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const form = $('#form'), errBox = $('#formError'), submitBtn = $('#submit');
  const state = { faceOn: null, downTheLine: null, configured: true, maxMb: 100 };
  const OK_EXT = /\.(mp4|mov|m4v|webm)$/i;

  fetch('/api/status').then(r => r.json()).then(s => {
    state.configured = s.configured; state.maxMb = s.maxUploadMb || 100;
    if (!s.configured) { $('#notConfigured').hidden = false; }
  }).catch(() => {});

  form.addEventListener('change', e => {
    if (e.target.name === 'problem') {
      const other = $('#otherText');
      other.hidden = e.target.value !== 'other';
      if (!other.hidden) other.focus();
    }
  });

  document.querySelectorAll('.angle').forEach(box => {
    const field = box.dataset.field;
    box.querySelectorAll('input[type=file]').forEach(inp => inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (!f) return;
      const typeOk = /^video\//.test(f.type) || OK_EXT.test(f.name);
      if (!typeOk) return showError(`"${f.name}" isn't a video. Please use MP4, MOV or WebM.`);
      if (f.size > state.maxMb * 1024 * 1024) return showError(`That video is ${(f.size / 1048576).toFixed(0)} MB — the limit is ${state.maxMb} MB. Trim it to just the swing and try again.`);
      hideError();
      state[field] = f;
      const v = $('video', box);
      if (v.src) URL.revokeObjectURL(v.src);
      v.src = URL.createObjectURL(f); v.hidden = false;
      const n = $('.file-name', box); n.hidden = false;
      n.textContent = `✅ ${f.name || 'recording'} · ${(f.size / 1048576).toFixed(1)} MB`;
      box.classList.add('ok');
    }));
  });

  function showError(msg) { errBox.textContent = msg; errBox.hidden = false; errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function hideError() { errBox.hidden = true; }

  form.addEventListener('submit', e => {
    e.preventDefault(); hideError();
    const problem = (form.querySelector('input[name=problem]:checked') || {}).value;
    if (!state.configured) return showError("Sorry — the coach isn't configured yet (no AI key on the server), so it can't analyse swings right now.");
    if (!problem) return showError("Pick your main problem first (step 1).");
    if (problem === 'other' && !$('#otherText').value.trim()) return showError('Tell us a little about what\'s going wrong.');
    if (!state.faceOn || !state.downTheLine) return showError('Please add both videos — face-on and down-the-line.');

    const fd = new FormData();
    fd.append('problem', problem);
    fd.append('otherText', $('#otherText').value);
    fd.append('faceOn', state.faceOn, state.faceOn.name || 'face-on.mov');
    fd.append('downTheLine', state.downTheLine, state.downTheLine.name || 'down-the-line.mov');

    form.hidden = true; $('#progress').hidden = false; $('#result').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setStage('Uploading your videos…', 0);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/analyze');
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) setStage(`Uploading your videos… ${Math.round(ev.loaded / ev.total * 100)}%`, ev.loaded / ev.total * 40); };
    xhr.onerror = () => fail('Network error while uploading. Check your connection and try again.');
    xhr.onload = () => {
      let body = {}; try { body = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 202 && body.jobId) return poll(body.jobId);
      if (xhr.status === 413) return fail(body.message || `A video is too large (limit ${state.maxMb} MB).`);
      fail(body.message || `Upload failed (HTTP ${xhr.status}).`);
    };
    xhr.send(fd);
  });

  function setStage(text, pct) { $('#stage').textContent = text; if (pct != null) $('#barFill').style.width = Math.min(100, pct) + '%'; }

  function poll(id) {
    let pct = 42, tries = 0;
    const tick = async () => {
      tries++;
      try {
        const r = await fetch('/api/jobs/' + id, { cache: 'no-store' });
        const j = await r.json();
        if (j.status === 'done') return showReport(j);
        if (j.status === 'error') return fail(j.error || 'Analysis failed.');
        pct = Math.min(95, pct + (95 - pct) * 0.05);
        setStage(j.stage || 'Analysing…', pct);
      } catch (_) { if (tries > 400) return fail('Lost connection to the server.'); }
      if (tries > 400) return fail('The analysis is taking too long. Please try again with shorter clips.');
      setTimeout(tick, 2500);
    };
    tick();
  }

  function showReport(j) {
    setStage('Done!', 100);
    $('#report').innerHTML = j.html;
    $('#modelNote').textContent = j.model ? `Analysis by ${j.model}` : '';
    $('#progress').hidden = true; $('#result').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function fail(msg) {
    $('#progress').hidden = true; form.hidden = false;
    showError(msg);
  }

  $('#again').addEventListener('click', () => {
    $('#result').hidden = true; form.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
