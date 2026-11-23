// ============================================================
//  CPCON UK CHATBOT — Configuration
//  Edit here to customise without touching the logic.
// ============================================================

const CPCON_CONFIG = {

  // -- Agent identity ---------------------------------------
  agentName:    'Camile',
  agentInitials:'CA',
  companyName:  'CPCON',

  // -- WhatsApp ---------------------------------------------
  // CPCON UK has NO WhatsApp line. Leave empty so the widget never
  // renders a WhatsApp button or builds a wa.me handoff. The handoff
  // CTA instead captures the visitor's details for the team, with a
  // mailto:contact@cpcongroup.com fallback.
  whatsappNumber: '',

  // -- Contact (used only for the email fallback / when asked) ----
  contactEmail: 'contact@cpcongroup.com',

  // -- Links ------------------------------------------------
  privacyUrl: 'https://cpcongroup.uk/privacy-policy',
  siteUrl:    'https://cpcongroup.uk',

  // -- Behaviour --------------------------------------------
  // Delay (ms) before simulating the agent "joining" the conversation.
  agentJoinDelay: 4000,

  // -- Keywords that trigger an immediate handoff to the team ----
  contactKeywords: /talk to|speak to|speak with|human|real person|sales|salesperson|call me|phone me|ring me|contact|get in touch|urgent|right now|immediately|support|representative|consultant|adviser|advisor/i,

  // -- LLM API ----------------------------------------------
  // Model and key are handled by the backend (/api/chat). Never expose the key on the front end.
  aiMaxTokens: 200,
};
