(() => {
  const menuButton = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.site-nav');
  if (menuButton && nav) {
    menuButton.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      menuButton.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
      nav.classList.remove('is-open');
      menuButton.setAttribute('aria-expanded', 'false');
    }));
  }

  const installTarget = document.querySelector('#install');
  const focusInstallTarget = (behavior = 'smooth') => {
    if (!installTarget) return;
    installTarget.scrollIntoView({ behavior, block: 'start' });
  };
  document.querySelectorAll('a[href="#install"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (window.location.hash !== '#install') history.pushState(null, '', '#install');
      focusInstallTarget();
    });
  });
  if (window.location.hash === '#install') {
    window.setTimeout(() => focusInstallTarget('auto'), 0);
  }

  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries, currentObserver) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          currentObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -40px' });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  const demoPreview = document.querySelector('.demo-video');
  const demoLaunch = document.querySelector('.demo-launch');
  const demoDialog = document.querySelector('.demo-dialog');
  const demoFullVideo = document.querySelector('.demo-full-video');
  const demoClose = document.querySelector('.demo-close');
  const studioDialog = document.querySelector('.studio-dialog');
  const studioOpen = document.querySelector('#openStudioGuide');
  const studioClose = document.querySelector('.studio-close');
  const tutorialDialog = document.querySelector('.tutorial-dialog');
  const tutorialOpen = document.querySelector('#openTutorialVideo');
  const tutorialPreview = document.querySelector('#openTutorialPreview');
  const tutorialClose = document.querySelector('.tutorial-close');
  const tutorialFrame = document.querySelector('.tutorial-frame');
  let playbackGeneration = 0;

  const loadCommunityStats = async () => {
    const hoursNode = document.querySelector('#communityHours');
    const weekNode = document.querySelector('#communityWeek');
    const historyNode = document.querySelector('#communityHistory');
    const sessionsNode = document.querySelector('#communitySessions');
    if (!hoursNode || !weekNode || !historyNode || !sessionsNode) return;

    const safeNumber = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : 0;
    };
    const format = new Intl.NumberFormat('ar', { maximumFractionDigits: 1 });

    try {
      const response = await fetch('/dablaja/api/stats', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('stats_unavailable');
      const stats = await response.json();
      const totalHours = safeNumber(stats.total_hours);
      const weekHours = safeNumber(stats.week_hours);
      const sessions = Math.floor(safeNumber(stats.total_sessions));
      hoursNode.textContent = format.format(totalHours);
      weekNode.textContent = weekHours
        ? `+${format.format(weekHours)} ساعة هذا الأسبوع`
        : 'بانتظار أولى جلسات المجتمع هذا الأسبوع';
      sessionsNode.textContent = `${new Intl.NumberFormat('ar').format(sessions)} جلسة`;

      const days = Array.isArray(stats.last_30_days) ? stats.last_30_days.slice(-30) : [];
      const values = Array.from({ length: 30 }, (_, index) => safeNumber(days[index]?.hours));
      const max = Math.max(1, ...values);
      historyNode.replaceChildren(...values.map((hours) => {
        const bar = document.createElement('i');
        bar.style.height = `${Math.max(7, Math.round((hours / max) * 100))}%`;
        bar.title = `${format.format(hours)} ساعة`;
        return bar;
      }));

      const platforms = stats.platforms && typeof stats.platforms === 'object' ? stats.platforms : {};
      document.querySelectorAll('.platform-row').forEach((row) => {
        const percent = Math.max(0, Math.min(100, safeNumber(platforms[row.dataset.platform])));
        row.querySelector('u').style.width = `${percent}%`;
        row.querySelector('strong').textContent = `${format.format(percent)}%`;
      });
    } catch {
      hoursNode.textContent = '—';
      weekNode.textContent = 'ستظهر الأرقام فور اتصال الموقع ببيانات المجتمع.';
      sessionsNode.textContent = '— جلسة';
      historyNode.replaceChildren(...Array.from({ length: 30 }, () => document.createElement('i')));
    }
  };

  loadCommunityStats();

  [demoPreview, demoFullVideo].filter(Boolean).forEach((video) => {
    video.addEventListener('error', () => video.classList.add('is-fallback'));
  });

  const pauseAndReset = (video) => {
    if (!video) return;
    video.pause();
    video.muted = true;
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      try { video.currentTime = 0; } catch {}
    }
  };

  const stopDemoPlayback = () => {
    playbackGeneration += 1;
    pauseAndReset(demoFullVideo);
    pauseAndReset(demoPreview);
  };

  const closeDemo = () => {
    stopDemoPlayback();
    if (demoDialog?.open) demoDialog.close();
  };

  if (demoLaunch && demoDialog && demoFullVideo) {
    demoLaunch.addEventListener('click', async () => {
      const generation = ++playbackGeneration;
      demoDialog.showModal();
      demoFullVideo.pause();
      if (demoFullVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
        try { demoFullVideo.currentTime = 0; } catch {}
      }
      demoFullVideo.muted = false;
      try {
        await demoFullVideo.play();
        if (generation !== playbackGeneration || !demoDialog.open) {
          pauseAndReset(demoFullVideo);
        }
      } catch {
        if (generation === playbackGeneration && demoDialog.open) {
          demoFullVideo.controls = true;
        }
      }
    });

    demoClose?.addEventListener('click', closeDemo);
    demoDialog.addEventListener('pointerdown', (event) => {
      const bounds = demoDialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) {
        event.preventDefault();
        closeDemo();
      }
    });
    demoDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDemo();
    });
    demoDialog.addEventListener('close', stopDemoPlayback);
    window.addEventListener('pagehide', stopDemoPlayback);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) closeDemo();
    });
  }

  const closeStudio = () => {
    if (studioDialog?.open) studioDialog.close();
  };

  if (studioOpen && studioDialog) {
    studioOpen.addEventListener('click', () => studioDialog.showModal());
    studioClose?.addEventListener('click', closeStudio);
    studioDialog.addEventListener('pointerdown', (event) => {
      const bounds = studioDialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) {
        event.preventDefault();
        closeStudio();
      }
    });
    studioDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeStudio();
    });
  }

  const closeTutorial = () => {
    if (!tutorialDialog) return;
    if (tutorialFrame) tutorialFrame.src = 'about:blank';
    if (tutorialDialog.open) tutorialDialog.close();
  };

  const openTutorial = () => {
    if (!tutorialDialog) return;
    if (tutorialFrame && tutorialFrame.src === 'about:blank') {
      tutorialFrame.src = tutorialFrame.dataset.src || '';
    }
    tutorialDialog.showModal();
  };

  if (tutorialDialog) {
    tutorialOpen?.addEventListener('click', openTutorial);
    tutorialPreview?.addEventListener('click', openTutorial);
    tutorialClose?.addEventListener('click', closeTutorial);
    tutorialDialog.addEventListener('pointerdown', (event) => {
      const bounds = tutorialDialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) {
        event.preventDefault();
        closeTutorial();
      }
    });
    tutorialDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeTutorial();
    });
    tutorialDialog.addEventListener('close', () => {
      if (tutorialFrame) tutorialFrame.src = 'about:blank';
    });
    window.addEventListener('pagehide', closeTutorial);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) closeTutorial();
    });
  }
})();
