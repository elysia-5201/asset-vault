import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ItemCardWeb } from "../types";

export function VirtualSearchResults({ items, list, render }: {
  items: ItemCardWeb[]; list: boolean; render: (item: ItemCardWeb) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ columns: 1, height: 340, start: 0, end: 5 });
  useLayoutEffect(() => {
    const element = root.current;
    const scroller = element?.closest(".col-scroll");
    if (!element || !scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const width = Math.max(0, element.clientWidth - 24);
      const min = document.documentElement.clientWidth >= 1500 ? 190 : 170;
      const columns = list ? 1 : Math.max(1, Math.floor((width + 10) / (min + 10)));
      const cardWidth = (width - (columns - 1) * 10) / columns;
      const height = list ? 122 : Math.ceil(cardWidth * 4 / 3) + 162;
      const above = scroller.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
      const start = Math.max(0, Math.floor(above / height) - 2);
      const end = start + Math.ceil(scroller.clientHeight / height) + 6;
      setWindow((previous) => previous.columns === columns && previous.height === height && previous.start === start && previous.end === end
        ? previous : { columns, height, start, end });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [list]);
  const rows = Math.ceil(items.length / window.columns);
  const start = Math.min(window.start, Math.max(0, rows - 1));
  const visible = items.slice(start * window.columns, Math.max(start + 1, window.end) * window.columns);
  return <div ref={root} className="search-results-window" style={{ height: items.length ? rows * window.height + 24 : 0 }}>
    <div className={"grid search-results-grid" + (list ? " search-results-list" : "")}
      style={{ top: start * window.height, gridTemplateColumns: "repeat(" + window.columns + ", minmax(0,1fr))", gridAutoRows: window.height - 10 }}>
      {visible.map(render)}
    </div>
  </div>;
}
