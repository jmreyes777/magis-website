import React from 'react';

const DateRangePicker = ({ startDate, endDate, onStartDateChange, onEndDateChange, presets = [] }) => {
  const handlePresetClick = (preset) => {
    const now = new Date();
    const start = new Date();
    
    switch (preset) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        onStartDateChange(start);
        onEndDateChange(now);
        break;
      case 'week':
        start.setDate(now.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        onStartDateChange(start);
        onEndDateChange(now);
        break;
      case 'month':
        start.setDate(now.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        onStartDateChange(start);
        onEndDateChange(now);
        break;
      case 'quarter':
        start.setDate(now.getDate() - 90);
        start.setHours(0, 0, 0, 0);
        onStartDateChange(start);
        onEndDateChange(now);
        break;
      default:
        break;
    }
  };

  return (
    <div className="date-range-picker">
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700">From:</label>
          <input
            type="date"
            value={startDate ? startDate.toISOString().split('T')[0] : ''}
            onChange={(e) => onStartDateChange(new Date(e.target.value))}
            className="form-input"
            style={{ width: 'auto' }}
          />
        </div>
        
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700">To:</label>
          <input
            type="date"
            value={endDate ? endDate.toISOString().split('T')[0] : ''}
            onChange={(e) => onEndDateChange(new Date(e.target.value))}
            className="form-input"
            style={{ width: 'auto' }}
          />
        </div>

        {presets.length > 0 && (
          <div className="flex gap-2">
            {presets.map((preset) => (
              <button
                key={preset}
                onClick={() => handlePresetClick(preset)}
                className="btn btn-primary"
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                {preset.charAt(0).toUpperCase() + preset.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DateRangePicker;
