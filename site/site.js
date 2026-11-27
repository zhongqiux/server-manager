(function () {
  'use strict';

  const cfg = window.SM_SITE || {};
  const downloadUrl = typeof cfg.downloadUrl === 'string' ? cfg.downloadUrl.trim() : '';

  function textAll(selector, value) {
    if (!value) return;
    document.querySelectorAll(selector).forEach(function (el) {
      el.textContent = value;
    });
  }

  textAll('[data-site-version]', cfg.version);
  textAll('[data-site-os]', cfg.os);
  textAll('[data-site-size]', cfg.size);

  const hashEl = document.querySelector('[data-download-hash]');
  if (hashEl && cfg.sha256) {
    hashEl.hidden = false;
    const code = hashEl.querySelector('code');
    if (code) code.textContent = cfg.sha256;
  }

  const pendingNote = document.querySelector('[data-download-pending]');
  document.querySelectorAll('[data-download]').forEach(function (link) {
    if (downloadUrl) {
      link.setAttribute('href', downloadUrl);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.classList.remove('is-pending');
      link.removeAttribute('aria-disabled');
    } else {
      link.classList.add('is-pending');
      link.setAttribute('aria-disabled', 'true');
      link.addEventListener('click', function (event) {
        event.preventDefault();
        const section = document.getElementById('download');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });
  if (pendingNote) pendingNote.hidden = Boolean(downloadUrl);

  const header = document.querySelector('.site-header');
  function onScroll() {
    if (header) header.classList.toggle('scrolled', window.scrollY > 8);
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

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

  const reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    reveals.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add('in');
    });
  }

  const lightbox = document.getElementById('lightbox');
  if (lightbox && typeof lightbox.showModal === 'function') {
    const image = lightbox.querySelector('img');
    const caption = lightbox.querySelector('p');
    const close = lightbox.querySelector('.lightbox-close');

    document.querySelectorAll('.shot').forEach(function (shot) {
      shot.addEventListener('click', function () {
        const src = shot.getAttribute('data-shot');
        if (!src) return;
        image.src = src;
        image.alt = shot.querySelector('img') ? shot.querySelector('img').alt : '';
        caption.textContent = shot.getAttribute('data-caption') || '';
        document.body.style.overflow = 'hidden';
        lightbox.showModal();
      });
    });

    function closeLightbox() {
      if (lightbox.open) lightbox.close();
      document.body.style.overflow = '';
      image.removeAttribute('src');
    }

    if (close) close.addEventListener('click', closeLightbox);
    lightbox.addEventListener('close', function () {
      document.body.style.overflow = '';
    });
    lightbox.addEventListener('click', function (event) {
      if (event.target === lightbox) closeLightbox();
    });
  }

  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();