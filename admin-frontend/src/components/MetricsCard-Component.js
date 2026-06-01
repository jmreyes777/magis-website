import React from 'react';

const MetricsCard = ({ title, value, change, changeType = 'neutral', icon, trend }) => {
  const getChangeColor = () => {
    if (changeType === 'positive') return 'text-green-600';
    if (changeType === 'negative') return 'text-red-600';
    return 'text-gray-600';
  };

  const getChangeIcon = () => {
    if (trend === 'up') return '↑';
    if (trend === 'down') return '↓';
    return '';
  };

  return (
    <div className="admin-card metrics-card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600 mb-1">{title}</p>
          <p className="text-3xl font-bold text-gray-900">{value}</p>
          {change && (
            <p className={`text-sm font-medium mt-2 ${getChangeColor()}`}>
              {getChangeIcon()} {change}
            </p>
          )}
        </div>
        {icon && (
          <div className="p-3 rounded-full bg-brand-focus-rgba">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
};

export default MetricsCard;
