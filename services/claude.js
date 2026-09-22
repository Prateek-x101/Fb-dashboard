/**
 * Claude Code CLI Integration Service
 * Uses locally installed Claude Code CLI (claude -p) for AI audience generation
 * No API key needed — uses Claude Pro OAuth session
 * No history saved — single-shot prompt mode
 */

const { execFile } = require('child_process');
const path = require('path');

// ─── Claude CLI availability check ───
let claudeAvailable = null;

async function isClaudeAvailable() {
    if (claudeAvailable !== null) return claudeAvailable;
    
    return new Promise((resolve) => {
        execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
            if (err) {
                console.log('[Claude] CLI not found or not installed.');
                claudeAvailable = false;
                resolve(false);
            } else {
                console.log(`[Claude] CLI available: v${stdout.trim()}`);
                claudeAvailable = true;
                resolve(true);
            }
        });
    });
}

// ─── Check if Claude is authenticated ───
async function isClaudeAuthenticated() {
    return new Promise((resolve) => {
        execFile('claude', ['-p', 'Say OK', '--output-format', 'text'], {
            timeout: 15000,
            env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
        }, (err, stdout, stderr) => {
            const output = (stdout || '') + (stderr || '');
            if (err || output.includes('Not logged in') || output.includes('/login')) {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

// ─── Execute Claude CLI prompt (single-shot, no history) ───
function runClaudePrompt(prompt, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-p', prompt,
            '--output-format', 'text',
            '--max-turns', '1'
        ];

        const env = {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
        };

        console.log(`[Claude] Sending prompt (${prompt.length} chars, timeout: ${timeoutMs / 1000}s)...`);
        const startTime = Date.now();

        const proc = execFile('claude', args, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 5, // 5MB buffer
            env
        }, (err, stdout, stderr) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            
            if (err) {
                const output = (stdout || '') + (stderr || '');
                if (output.includes('Not logged in') || output.includes('/login')) {
                    reject(new Error('Claude not authenticated. Please run "claude" in terminal and login first.'));
                } else {
                    reject(new Error(`Claude CLI error after ${elapsed}s: ${err.message}`));
                }
                return;
            }

            console.log(`[Claude] Response received in ${elapsed}s (${stdout.length} chars)`);
            resolve(stdout.trim());
        });
    });
}

// ─── Parse JSON from Claude response ───
function extractJSON(text) {
    // Try to find JSON array or object in the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch {}
    }

    // Try parsing between ```json blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        try { return JSON.parse(codeBlockMatch[1].trim()); } catch {}
    }

    throw new Error('Could not parse JSON from Claude response');
}

// ─── Generate High-Performance Audiences with Meta Account Data ───
async function generateAudiences(productContent, numAudiences = 5, alreadyUsed = [], metaInsights = null, imagesBase64 = []) {
    
    const available = await isClaudeAvailable();
    if (!available) throw new Error('Claude Code CLI not installed. Run: npm install -g @anthropic-ai/claude-code');

    // Build the mega-prompt with real performance data
    let performanceContext = '';
    if (metaInsights && metaInsights.topPerformers) {
        performanceContext = `
## REAL META ADS PERFORMANCE DATA (Last 30 Days)
This is ACTUAL data from the advertiser's Meta Ads account. Use this to inform your audience suggestions.

### Top Performing Campaigns:
${JSON.stringify(metaInsights.topPerformers, null, 2)}

### Best Demographics:
${metaInsights.demographics ? JSON.stringify(metaInsights.demographics, null, 2) : 'Not available'}

### Best Performing Interests/Audiences:
${metaInsights.bestInterests ? JSON.stringify(metaInsights.bestInterests, null, 2) : 'Not available'}

### Account Averages:
- Average CPC: ${metaInsights.avgCPC || 'N/A'}
- Average CTR: ${metaInsights.avgCTR || 'N/A'}  
- Average CPM: ${metaInsights.avgCPM || 'N/A'}
- Best performing age range: ${metaInsights.bestAgeRange || 'N/A'}
- Best performing gender: ${metaInsights.bestGender || 'N/A'}
- Best performing locations: ${metaInsights.bestLocations ? JSON.stringify(metaInsights.bestLocations) : 'N/A'}

IMPORTANT: Use this real performance data to generate audiences that build upon what's ALREADY WORKING. Don't just repeat the same audiences — find adjacent interests and demographics that would likely perform similarly or better.
`;
    }

    let alreadyUsedContext = '';
    if (alreadyUsed.length > 0) {
        alreadyUsedContext = `
## ALREADY USED AUDIENCES (DO NOT REPEAT THESE):
${JSON.stringify(alreadyUsed, null, 2)}

Generate COMPLETELY DIFFERENT audiences from the ones listed above. No overlapping interests.
`;
    }

    const prompt = `You are an elite Facebook Ads audience targeting specialist with 10+ years of experience managing high-budget ad campaigns. Your task is to generate ${numAudiences} high-performance Facebook ad audience segments for the following product/website.

## PRODUCT/WEBSITE CONTENT:
${productContent}

${performanceContext}

${alreadyUsedContext}

## OUTPUT REQUIREMENTS:
Generate exactly ${numAudiences} audience segments. Each audience MUST follow this EXACT JSON structure:

\`\`\`json
[
  {
    "audienceName": "Descriptive Audience Name",
    "ageMin": 25,
    "ageMax": 45,
    "gender": "all",
    "targeting": [
      { "name": "Online shopping", "type": "interest" },
      { "name": "Fashion", "type": "interest" },
      { "name": "Instagram", "type": "interest" }
    ],
    "locationsInclude": [
      { "name": "United States", "type": "country" },
      { "name": "United Kingdom", "type": "country" }
    ],
    "locationsExclude": [],
    "reasoning": "Why this audience will perform well based on the data"
  }
]
\`\`\`

## CRITICAL RULES:
1. "targeting" array: Each item needs "name" (Facebook-recognized interest) and "type" (one of: "interest", "behavior", "employer", "job_title", "education_school", "education_major", "work_position", "locale").
2. "gender": Must be "all", "male", or "female"
3. "locationsInclude": Each needs "name" and "type" (one of: "country", "region", "city", "zip", "geo_market")
4. Use REAL Facebook interest names that exist in Facebook's targeting system. Be specific — use exact names like "Online shopping", "Fitness and wellness", "Luxury goods", etc.
5. Each audience should have 4-8 targeting interests for optimal reach
6. Include "reasoning" explaining WHY this audience will convert based on the product and performance data
7. Make audiences diverse — don't create 5 similar audiences. Cover different angles: demographics, interests, behaviors, lookalike strategies
8. Age ranges should be realistic for the product
${metaInsights ? '9. LEVERAGE the real performance data — build upon demographics and interests that are already showing results' : ''}

Return ONLY the JSON array. No explanation outside the JSON.`;

    const response = await runClaudePrompt(prompt, 120000);
    const audiences = extractJSON(response);
    
    if (!Array.isArray(audiences)) {
        throw new Error('Claude did not return an array of audiences');
    }

    // Normalize the response
    return audiences.map(aud => ({
        audienceName: aud.audienceName || aud.name || 'Untitled Audience',
        name: aud.audienceName || aud.name || 'Untitled Audience',
        ageMin: aud.ageMin || 18,
        ageMax: aud.ageMax || 65,
        gender: aud.gender || 'all',
        targeting: (aud.targeting || []).map(t => ({
            name: t.name,
            type: t.type || 'interest'
        })),
        locationsInclude: aud.locationsInclude || [{ name: 'United States', type: 'country' }],
        locationsExclude: aud.locationsExclude || [],
        reasoning: aud.reasoning || '',
        source: 'claude'
    }));
}

// ─── Fetch Meta Ads Insights for the active account ───
async function fetchMetaInsights(accountId, accessToken) {
    if (!accountId || !accessToken) return null;

    const fetch = require('node-fetch');
    const cleanId = accountId.toString().replace(/^act_/, '');
    const baseUrl = `https://graph.facebook.com/v25.0/act_${cleanId}`;
    
    const insights = {
        topPerformers: [],
        demographics: null,
        bestInterests: null,
        avgCPC: null,
        avgCTR: null,
        avgCPM: null,
        bestAgeRange: null,
        bestGender: null,
        bestLocations: null
    };

    try {
        // 1. Get campaign insights (last 30 days)
        const campaignUrl = `${baseUrl}/insights?fields=campaign_name,impressions,clicks,spend,cpc,ctr,cpm,actions&date_preset=last_30d&level=campaign&sort=spend_descending&limit=10&access_token=${accessToken}`;
        const campaignResp = await fetch(campaignUrl);
        const campaignData = await campaignResp.json();
        
        if (campaignData.data && campaignData.data.length > 0) {
            insights.topPerformers = campaignData.data.map(c => ({
                name: c.campaign_name,
                impressions: c.impressions,
                clicks: c.clicks,
                spend: c.spend,
                cpc: c.cpc,
                ctr: c.ctr,
                cpm: c.cpm,
                conversions: (c.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase')?.value || 0
            }));

            // Calculate averages
            const totals = campaignData.data.reduce((acc, c) => {
                acc.cpc += parseFloat(c.cpc || 0);
                acc.ctr += parseFloat(c.ctr || 0);
                acc.cpm += parseFloat(c.cpm || 0);
                acc.count++;
                return acc;
            }, { cpc: 0, ctr: 0, cpm: 0, count: 0 });

            insights.avgCPC = (totals.cpc / totals.count).toFixed(2);
            insights.avgCTR = (totals.ctr / totals.count).toFixed(2) + '%';
            insights.avgCPM = (totals.cpm / totals.count).toFixed(2);
        }

        // 2. Get age/gender breakdown
        const demoUrl = `${baseUrl}/insights?fields=impressions,clicks,ctr,spend&date_preset=last_30d&breakdowns=age,gender&sort=clicks_descending&limit=20&access_token=${accessToken}`;
        const demoResp = await fetch(demoUrl);
        const demoData = await demoResp.json();

        if (demoData.data && demoData.data.length > 0) {
            insights.demographics = demoData.data.slice(0, 10).map(d => ({
                age: d.age,
                gender: d.gender,
                clicks: d.clicks,
                ctr: d.ctr,
                spend: d.spend
            }));

            // Find best performing age/gender
            const bestDemo = demoData.data[0];
            if (bestDemo) {
                insights.bestAgeRange = bestDemo.age;
                insights.bestGender = bestDemo.gender === 'male' ? 'Male' : bestDemo.gender === 'female' ? 'Female' : 'All';
            }
        }

        // 3. Get location breakdown
        const locationUrl = `${baseUrl}/insights?fields=impressions,clicks,ctr&date_preset=last_30d&breakdowns=country&sort=clicks_descending&limit=10&access_token=${accessToken}`;
        const locationResp = await fetch(locationUrl);
        const locationData = await locationResp.json();

        if (locationData.data && locationData.data.length > 0) {
            insights.bestLocations = locationData.data.slice(0, 5).map(l => ({
                country: l.country,
                clicks: l.clicks,
                ctr: l.ctr
            }));
        }

        console.log(`[Claude] Meta insights fetched: ${insights.topPerformers.length} campaigns, ${(insights.demographics || []).length} demo breakdowns`);
        return insights;

    } catch (err) {
        console.warn(`[Claude] Failed to fetch Meta insights: ${err.message}`);
        return null;
    }
}

module.exports = {
    isClaudeAvailable,
    isClaudeAuthenticated,
    generateAudiences,
    fetchMetaInsights,
    runClaudePrompt
};
