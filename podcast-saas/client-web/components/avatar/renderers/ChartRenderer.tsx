'use client';

import { useEffect, useRef } from 'react';
import {
  Chart as ChartJS,
  BarController, LineController, PieController, DoughnutController,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  ArcElement, Title, Tooltip, Legend, Filler,
  type ChartConfiguration,
} from 'chart.js';
import type { ChartDataset } from '../avatarApi';

// Raw Chart.js (no react-chartjs-2 wrapper) requires the CONTROLLERS to be
// registered, not just the elements — otherwise: `"bar" is not a registered controller`.
ChartJS.register(
  BarController, LineController, PieController, DoughnutController,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  ArcElement, Title, Tooltip, Legend, Filler,
);

interface Props {
  chartType: 'bar' | 'line' | 'pie';
  title: string;
  labels: string[];
  datasets: ChartDataset[];
  height?: number | string;
}

// Renders Chart.js directly (no react-chartjs-2) to avoid React-version peer friction.
export function ChartRenderer({ chartType, title, labels, datasets, height = 240 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartJS | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();

    const isPie = chartType === 'pie';
    const config: ChartConfiguration = {
      type: chartType,
      data: { labels, datasets: datasets as unknown as ChartConfiguration['data']['datasets'] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        plugins: {
          legend: { labels: { color: '#e0e0e0', font: { size: 12 } } },
          title: { display: !isPie && !!title, text: title, color: '#e0e0e0', font: { size: 14 } },
          tooltip: { backgroundColor: '#1e2a3a', titleColor: '#e0e0e0', bodyColor: '#b0bec5' },
        },
        scales: isPie ? {} : {
          x: { ticks: { color: '#90a4ae' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#90a4ae' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        },
      },
    };
    chartRef.current = new ChartJS(canvasRef.current, config);
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [chartType, title, labels, datasets]);

  return (
    <div className="avatar-chart-renderer" style={{ width: '100%' }}>
      {chartType === 'pie' && title && <p className="avatar-chart-title">{title}</p>}
      <div style={{ height, position: 'relative' }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
