(function () {
  'use strict';

  const cfg = window.SM_SITE || {};
  const downloads = cfg.downloads || {};
  const legacyDownloadUrl = typeof cfg.downloadUrl === 'string' ? cfg.downloadUrl.trim() : '';

  function platformUrl(key) {
    const value = downloads[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    return key === 'windows' ? legacyDownloadUrl : '';
  }

  function textAll(selector, value) {
    if (!value) return;
    document.querySelectorAll(selector).forEach(function (el) {
      el.textContent = value;
    });
  }

  textAll('[data-site-version]', cfg.version);
  textAll('[data-site-os]', cfg.os);
  textAll('[data-site-size]', cfg.size);

  const checksumsEl = document.querySelector('[data-download-checksums]');
  const checksumsLink = document.querySelector('[data-checksums-link]');
  const checksumsUrl = typeof cfg.checksumsUrl === 'string' ? cfg.checksumsUrl.trim() : '';
  if (checksumsEl && checksumsLink && checksumsUrl) {
    checksumsLink.setAttribute('href', checksumsUrl);
    checksumsEl.hidden = false;
  }

  const pendingNote = document.querySelector('[data-download-pending]');
  let hasAnyDownload = false;
  document.querySelectorAll('[data-download-platform]').forEach(function (link) {
    const url = platformUrl(link.getAttribute('data-download-platform') || '');
    if (url) {
      hasAnyDownload = true;
      link.setAttribute('href', url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.classList.remove('is-pending');
      link.removeAttribute('aria-disabled');
      return;
    }
    link.classList.add('is-pending');
    link.setAttribute('aria-disabled', 'true');
    link.addEventListener('click', function (event) {
      event.preventDefault();
      const section = document.getElementById('download');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  if (pendingNote) pendingNote.hidden = hasAnyDownload;

  /* ---------- header ---------- */

  const header = document.querySelector('.site-header');

  function updateHeader() {
    if (header) header.classList.toggle('scrolled', window.scrollY > 8);
  }

  const navToggle = document.querySelector('.nav-toggle');
  if (header && navToggle) {
    const closeNav = function () {
      header.classList.remove('nav-open');
      navToggle.setAttribute('aria-expanded', 'false');
      navToggle.setAttribute('aria-label', '打开导航');
    };
    navToggle.addEventListener('click', function () {
      const open = header.classList.toggle('nav-open');
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
    });
    header.querySelectorAll('.site-nav a').forEach(function (link) {
      link.addEventListener('click', closeNav);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeNav();
    });
  }

  /* ---------- scroll deck ---------- */

  const slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  const dotButtons = Array.prototype.slice.call(document.querySelectorAll('[data-slide-link]'));
  const progressBar = document.querySelector('.deck-progress i');
  const navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a'));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let current = -1;

  slides.forEach(function (slide) {
    slide.querySelectorAll('.anim').forEach(function (el, index) {
      el.style.setProperty('--i', String(index));
    });
  });

  function setActive(index) {
    if (index < 0 || index >= slides.length || index === current) return;
    current = index;
    const activeId = slides[index].id;

    slides.forEach(function (slide, i) {
      slide.classList.toggle('is-active', i === index);
    });

    dotButtons.forEach(function (button) {
      const on = button.getAttribute('data-slide-link') === activeId;
      button.classList.toggle('is-active', on);
      if (on) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });

    navLinks.forEach(function (link) {
      link.classList.toggle('is-current', link.getAttribute('href') === '#' + activeId);
    });

    if (progressBar) progressBar.style.width = ((index + 1) / slides.length) * 100 + '%';
  }

  function detectActive() {
    const mid = window.innerHeight * 0.5;
    let index = 0;
    slides.forEach(function (slide, i) {
      const rect = slide.getBoundingClientRect();
      if (rect.top <= mid && rect.bottom > mid) index = i;
    });
    setActive(index);
  }

  function goTo(index) {
    const slide = slides[Math.max(0, Math.min(slides.length - 1, index))];
    if (!slide) return;
    slide.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  dotButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      const target = document.getElementById(button.getAttribute('data-slide-link') || '');
      if (target) {
        const index = slides.indexOf(target);
        if (index >= 0) goTo(index);
      }
    });
  });

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const tag = (target && target.tagName ? target.tagName : '').toLowerCase();
    if (target && (target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a' || tag === 'summary')) return;

    if (event.key === 'Home') {
      event.preventDefault();
      goTo(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      goTo(slides.length - 1);
      return;
    }

    let delta = 0;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') delta = 1;
    else if (event.key === 'ArrowUp' || event.key === 'PageUp') delta = -1;
    else return;

    event.preventDefault();
    goTo(current + delta);
  });

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      updateHeader();
      detectActive();
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('load', onScroll);

  updateHeader();
  void document.body.offsetHeight;
  detectActive();
  if (current === -1) setActive(0);

  /* ---------- how preview ---------- */

  const howRows = Array.prototype.slice.call(document.querySelectorAll('.how-row[data-step]'));
  const howShots = Array.prototype.slice.call(document.querySelectorAll('[data-how-shot]'));
  const howFloats = Array.prototype.slice.call(document.querySelectorAll('[data-how-float]'));
  const howAddress = document.querySelector('[data-how-address]');
  let howStep = -1;

  function setHowStep(index) {
    if (index === howStep) return;
    howStep = index;
    howRows.forEach(function (row) {
      row.classList.toggle('is-current', Number(row.getAttribute('data-step')) === index);
    });
    howShots.forEach(function (shot) {
      shot.classList.toggle('is-on', Number(shot.getAttribute('data-how-shot')) === index);
    });
    howFloats.forEach(function (card) {
      card.classList.toggle('is-on', Number(card.getAttribute('data-how-float')) === index);
    });
    if (howAddress && howRows[index]) {
      howAddress.textContent = howRows[index].getAttribute('data-address') || '';
    }
  }

  howRows.forEach(function (row) {
    row.addEventListener('mouseenter', function () {
      setHowStep(Number(row.getAttribute('data-step')));
    });
  });
  if (howRows.length) setHowStep(0);

  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();