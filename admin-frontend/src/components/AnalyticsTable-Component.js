import React, { useState } from 'react';

const AnalyticsTable = ({ 
  columns, 
  data, 
  sortable = true, 
  filterable = true,
  pageSize = 10 
}) => {
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
  const [filterTerm, setFilterTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const handleSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const getSortedData = () => {
    if (!sortConfig.key) return data;

    return [...data].sort((a, b) => {
      const aValue = a[sortConfig.key];
      const bValue = b[sortConfig.key];

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const getFilteredData = () => {
    if (!filterTerm) return getSortedData();

    return getSortedData().filter(item => {
      return columns.some(column => {
        const value = item[column.key];
        return String(value).toLowerCase().includes(filterTerm.toLowerCase());
      });
    });
  };

  const getPaginatedData = () => {
    const filtered = getFilteredData();
    const startIndex = (currentPage - 1) * pageSize;
    return filtered.slice(startIndex, startIndex + pageSize);
  };

  const totalPages = Math.ceil(getFilteredData().length / pageSize);

  return (
    <div className="analytics-table-container">
      {filterable && (
        <div className="mb-4">
          <input
            type="text"
            placeholder="Filter results..."
            value={filterTerm}
            onChange={(e) => {
              setFilterTerm(e.target.value);
              setCurrentPage(1);
            }}
            className="form-input"
          />
        </div>
      )}

      <table className="analytics-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                onClick={() => sortable && handleSort(column.key)}
                className={sortable ? 'cursor-pointer' : ''}
              >
                <div className="flex items-center">
                  {column.label}
                  {sortable && sortConfig.key === column.key && (
                    <span className="ml-2">
                      {sortConfig.direction === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {getPaginatedData().map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>
                  {column.render ? column.render(row[column.key], row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4">
          <p className="text-sm text-gray-600">
            Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, getFilteredData().length)} of {getFilteredData().length} results
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="btn btn-primary"
            >
              Previous
            </button>
            <button
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
              className="btn btn-primary"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnalyticsTable;
