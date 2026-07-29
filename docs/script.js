const navToggle = document.getElementById("nav-toggle");
const navLinks = document.getElementById("nav-links");

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener("click", (event) => {
    const id = anchor.getAttribute("href");
    if (!id || id === "#") return;
    const target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    const top = target.getBoundingClientRect().top + window.pageYOffset - 72;
    window.scrollTo({ top, behavior: "smooth" });
  });
});

document.querySelectorAll(".code-block").forEach((block) => {
  block.tabIndex = 0;
  block.title = "点击复制命令";
  block.addEventListener("click", async () => {
    const text = block.innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const previous = block.title;
      block.title = "已复制";
      window.setTimeout(() => {
        block.title = previous;
      }, 1200);
    } catch {
      block.title = "复制失败";
    }
  });
});

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });

  document.querySelectorAll(".feature-grid article, .deploy-card, .connect-card, .architecture > div").forEach((element) => {
    element.classList.add("reveal");
    observer.observe(element);
  });
}
