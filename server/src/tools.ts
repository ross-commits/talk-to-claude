/**
 * TTC Call Tools — Infrastructure toolkit available during voice calls
 *
 * Tools that the voice AI can invoke mid-conversation to query metrics,
 * run commands, check services, and manage Docker containers across
 * lab/infrastructure hosts.
 *
 * Configuration via environment variables:
 *   TTC_LAB_HOSTS — JSON map of hostname -> { ip, user }
 *   TTC_LAB_SERVICES — JSON map of service -> { url, name }
 *   TTC_PROMETHEUS_URL — Prometheus query endpoint
 */

import { exec } from 'child_process';
import type { ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

// ---------------------------------------------------------------------------
// Host + service configuration (from env vars)
// ---------------------------------------------------------------------------

interface HostInfo { ip: string; user: string }
interface ServiceInfo { url: string; name: string }

/**
 * Parse lab hosts from TTC_LAB_HOSTS env var.
 * Format: JSON object { "hostname": { "ip": "x.x.x.x", "user": "username" }, ... }
 */
function loadHosts(): Record<string, HostInfo> {
  const raw = process.env.TTC_LAB_HOSTS;
  if (!raw) {
    console.error('[Tools] TTC_LAB_HOSTS not set — lab tools will be unavailable');
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Tools] Failed to parse TTC_LAB_HOSTS:', e);
    return {};
  }
}

/**
 * Parse service health checks from TTC_LAB_SERVICES env var.
 * Format: JSON object { "svc": { "url": "http://...", "name": "Display Name" }, ... }
 */
function loadServices(): Record<string, ServiceInfo> {
  const raw = process.env.TTC_LAB_SERVICES;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Tools] Failed to parse TTC_LAB_SERVICES:', e);
    return {};
  }
}

const HOSTS = loadHosts();
const SERVICES = loadServices();
const PROMETHEUS_URL = process.env.TTC_PROMETHEUS_URL || '';

const hostNames = Object.keys(HOSTS);
const serviceNames = Object.keys(SERVICES);

// ---------------------------------------------------------------------------
// Tool definitions (Bedrock ToolConfiguration format)
// ---------------------------------------------------------------------------

export const CALL_TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'get_system_metrics',
        description: 'Query Prometheus for system metrics. Returns current values for CPU, memory, GPU, disk, or network usage on any lab machine.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: `Which machine to query (${hostNames.join(', ') || 'none configured'})`,
              },
              metric: {
                type: 'string',
                enum: ['cpu', 'memory', 'disk', 'gpu', 'network', 'uptime', 'load'],
                description: 'Which metric to check',
              },
            },
            required: ['host', 'metric'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'run_command',
        description: 'Run a shell command on a lab machine via SSH. Use for quick checks or actions. Command output is returned. Timeout: 10 seconds.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: `Which machine to run the command on (${hostNames.join(', ') || 'none configured'})`,
              },
              command: {
                type: 'string',
                description: 'Shell command to execute (e.g. "df -h", "nvidia-smi", "uptime")',
              },
            },
            required: ['host', 'command'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'docker_status',
        description: 'Check Docker container status, get logs, or manage containers on a lab machine.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: `Which machine to check (${hostNames.join(', ') || 'none configured'})`,
              },
              action: {
                type: 'string',
                enum: ['ps', 'logs', 'restart', 'stop'],
                description: 'Action: ps (list), logs (last 20 lines), restart, stop',
              },
              container: {
                type: 'string',
                description: 'Container name (required for logs/restart/stop)',
              },
            },
            required: ['host', 'action'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'service_health',
        description: `Check health of lab services. Use "all" to check everything. Available: ${serviceNames.join(', ') || 'none configured'}`,
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              service: {
                type: 'string',
                description: `Service name (${serviceNames.join(', ') || 'none'}) or "all"`,
              },
            },
            required: ['service'],
          },
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function executeTool(
  toolName: string,
  input: Record<string, any>
): Promise<string> {
  try {
    switch (toolName) {
      case 'get_system_metrics':
        return await getSystemMetrics(input.host, input.metric);
      case 'run_command':
        return await runCommand(input.host, input.command);
      case 'docker_status':
        return await dockerStatus(input.host, input.action, input.container);
      case 'service_health':
        return await serviceHealth(input.service);
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Tools] ${toolName} error:`, msg);
    return `Error: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function getSystemMetrics(host: string, metric: string): Promise<string> {
  const hostInfo = HOSTS[host];
  if (!hostInfo) return `Unknown host: ${host}. Available: ${hostNames.join(', ')}`;

  if (!PROMETHEUS_URL) return 'Prometheus URL not configured (set TTC_PROMETHEUS_URL)';

  // Build Prometheus query based on metric type
  const instance = `${hostInfo.ip}:9100`; // node_exporter
  let query: string;

  switch (metric) {
    case 'cpu':
      query = `100 - (avg by(instance) (irate(node_cpu_seconds_total{instance="${instance}",mode="idle"}[5m])) * 100)`;
      break;
    case 'memory':
      query = `(1 - node_memory_MemAvailable_bytes{instance="${instance}"} / node_memory_MemTotal_bytes{instance="${instance}"}) * 100`;
      break;
    case 'disk':
      query = `(1 - node_filesystem_avail_bytes{instance="${instance}",mountpoint="/"} / node_filesystem_size_bytes{instance="${instance}",mountpoint="/"}) * 100`;
      break;
    case 'gpu':
      // nvidia-smi via SSH for GPU hosts
      return runCommand(host, 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits');
    case 'network':
      query = `irate(node_network_receive_bytes_total{instance="${instance}",device!="lo"}[5m])`;
      break;
    case 'uptime':
      query = `node_time_seconds{instance="${instance}"} - node_boot_time_seconds{instance="${instance}"}`;
      break;
    case 'load':
      query = `node_load1{instance="${instance}"}`;
      break;
    default:
      return `Unknown metric: ${metric}`;
  }

  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await response.json() as any;

    if (data.status !== 'success' || !data.data?.result?.length) {
      return `No data for ${metric} on ${host}. Prometheus may not have this metric.`;
    }

    const result = data.data.result[0];
    const value = parseFloat(result.value[1]);

    switch (metric) {
      case 'cpu':
        return `${host} CPU: ${value.toFixed(1)}% used`;
      case 'memory':
        return `${host} Memory: ${value.toFixed(1)}% used`;
      case 'disk':
        return `${host} Disk (/): ${value.toFixed(1)}% used`;
      case 'network':
        return `${host} Network rx: ${(value / 1024 / 1024).toFixed(2)} MB/s`;
      case 'uptime': {
        const days = Math.floor(value / 86400);
        const hours = Math.floor((value % 86400) / 3600);
        return `${host} uptime: ${days} days, ${hours} hours`;
      }
      case 'load':
        return `${host} load average (1m): ${value.toFixed(2)}`;
      default:
        return `${host} ${metric}: ${value}`;
    }
  } catch (error) {
    return `Failed to query Prometheus: ${error instanceof Error ? error.message : error}`;
  }
}

async function runCommand(host: string, command: string): Promise<string> {
  const hostInfo = HOSTS[host];
  if (!hostInfo) return `Unknown host: ${host}. Available: ${hostNames.join(', ')}`;

  // Basic sanitization — no shell metacharacters
  const sanitized = command.replace(/[;&|`$]/g, '');

  return new Promise((resolve) => {
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${hostInfo.user}@${hostInfo.ip} '${sanitized}'`;
    exec(sshCmd, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Command failed: ${stderr || error.message}`);
      } else {
        const output = stdout.trim();
        resolve(output || '(no output)');
      }
    });
  });
}

async function dockerStatus(host: string, action: string, container?: string): Promise<string> {
  const hostInfo = HOSTS[host];
  if (!hostInfo) return `Unknown host: ${host}. Available: ${hostNames.join(', ')}`;

  let cmd: string;
  switch (action) {
    case 'ps':
      cmd = 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not available"';
      break;
    case 'logs':
      if (!container) return 'Container name required for logs';
      cmd = `docker logs --tail 20 ${container} 2>&1`;
      break;
    case 'restart':
      if (!container) return 'Container name required for restart';
      cmd = `docker restart ${container} 2>&1`;
      break;
    case 'stop':
      if (!container) return 'Container name required for stop';
      cmd = `docker stop ${container} 2>&1`;
      break;
    default:
      return `Unknown action: ${action}`;
  }

  return runCommand(host, cmd);
}

async function serviceHealth(service: string): Promise<string> {
  if (service === 'all') {
    if (serviceNames.length === 0) return 'No services configured (set TTC_LAB_SERVICES)';
    const results = await Promise.all(
      Object.entries(SERVICES).map(async ([key, svc]) => {
        const status = await checkHealth(svc.url);
        return `${svc.name}: ${status}`;
      })
    );
    return results.join('\n');
  }

  const svc = SERVICES[service];
  if (!svc) {
    return `Unknown service: ${service}. Available: ${serviceNames.join(', ')}`;
  }

  const status = await checkHealth(svc.url);
  return `${svc.name}: ${status}`;
}

async function checkHealth(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      return 'healthy';
    }
    return `unhealthy (HTTP ${response.status})`;
  } catch (error) {
    return `unreachable (${error instanceof Error ? error.message : 'timeout'})`;
  }
}
