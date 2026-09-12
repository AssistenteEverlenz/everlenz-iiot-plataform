'use client';

import { usePoll, type DashboardWidget } from './data';
import { QuickChart, type QuickStatistic } from './QuickChart';

// Second page of the TV: the dashboard's own product charts (donuts and bars), as configured on
// the dashboard — ranking, average, comparison with the previous period, peak and leader — at
// wall size. Each card reads its own default period; a custom range reads as the last 7 days.

const PERIOD_TEXT: Record<string, string> = {
  today: 'hoje',
  '7d': 'últimos 7 dias',
  week: 'esta semana',
  month: 'este mês',
  year: 'este ano',
  '30d': 'últimos 30 dias',
};

export function TvProductsPage({
  dashboardId,
  widgets,
}: {
  dashboardId: string;
  widgets: DashboardWidget[];
}) {
  return (
    <div className={`tv3-products-page count-${widgets.length}`}>
      {widgets.map((widget) => (
        <TvQuick key={widget.id} dashboardId={dashboardId} widget={widget} />
      ))}
    </div>
  );
}

function TvQuick({ dashboardId, widget }: { dashboardId: string; widget: DashboardWidget }) {
  const configured = widget.config.productionDefaultPeriod;
  const period = configured && configured !== 'custom' ? configured : '7d';
  const statistics = usePoll<QuickStatistic[]>(
    `/dashboards/${dashboardId}/statistics?widgetId=${widget.id}&period=${period}`,
    60000,
  );
  const text = PERIOD_TEXT[period] ?? 'últimos 7 dias';
  return (
    <section className="tv3-card tv3-quick">
      <div className="tv3-card-title">
        <strong>{widget.title}</strong>
        <span>{text}</span>
      </div>
      <div className="tv3-quick-body">
        {statistics.data ? (
          <QuickChart
            widget={widget}
            statistics={statistics.data[0]}
            periodChips={null}
            periodText={text}
          />
        ) : (
          <div className="tv3-loading">
            {statistics.error ?? <span className="detail-spinner" aria-label="Carregando" />}
          </div>
        )}
      </div>
    </section>
  );
}
