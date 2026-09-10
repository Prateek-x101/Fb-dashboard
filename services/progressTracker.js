/**
 * In-Memory Real-Time Progress Tracker for Shopify Import & Image Translation
 */

class ProgressTracker {
    constructor() {
        this.jobs = new Map();

        // Auto-cleanup jobs older than 15 minutes
        setInterval(() => {
            const now = Date.now();
            for (const [id, job] of this.jobs.entries()) {
                if (now - job.createdAt > 15 * 60 * 1000) {
                    this.jobs.delete(id);
                }
            }
        }, 60 * 1000);
    }

    getOrCreateJob(jobId) {
        if (!jobId) jobId = 'default_job';
        if (!this.jobs.has(jobId)) {
            this.jobs.set(jobId, {
                id: jobId,
                step: 'init',
                message: 'Starting process...',
                progress: 0,
                etaSeconds: null,
                createdAt: Date.now(),
                lastUpdated: Date.now(),
                logs: [],
                stats: {
                    totalImages: 0,
                    completedImages: 0,
                    translatedImages: 0,
                    failedImages: 0,
                    failedList: [],
                    variantsTotal: 0,
                    variantsLinked: 0
                },
                done: false,
                error: null
            });
        }
        return this.jobs.get(jobId);
    }

    log(jobId, message, options = {}) {
        const job = this.getOrCreateJob(jobId);
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        
        job.message = message;
        job.lastUpdated = Date.now();

        if (options.step) job.step = options.step;
        if (options.progress !== undefined) job.progress = Math.min(100, Math.max(0, options.progress));
        if (options.etaSeconds !== undefined) job.etaSeconds = options.etaSeconds;
        if (options.stats) Object.assign(job.stats, options.stats);
        if (options.error) job.error = options.error;
        if (options.done !== undefined) job.done = options.done;

        const logEntry = {
            time: timestamp,
            text: message,
            type: options.type || 'info', // 'info' | 'success' | 'warn' | 'error' | 'gemini'
            meta: options.meta || null
        };

        job.logs.push(logEntry);
        // Retain last 80 logs to keep payload token/network lightweight
        if (job.logs.length > 80) job.logs.shift();

        return job;
    }

    getJob(jobId) {
        if (!jobId) return null;
        return this.jobs.get(jobId) || null;
    }

    finishJob(jobId, successMessage = 'Process completed successfully! 🎉') {
        return this.log(jobId, successMessage, {
            step: 'completed',
            progress: 100,
            etaSeconds: 0,
            done: true,
            type: 'success'
        });
    }

    failJob(jobId, errorMessage) {
        return this.log(jobId, `❌ Error: ${errorMessage}`, {
            step: 'failed',
            progress: 100,
            etaSeconds: 0,
            done: true,
            error: errorMessage,
            type: 'error'
        });
    }
}

const progressTracker = new ProgressTracker();
module.exports = progressTracker;
