// Owns: the feedback notice available before Send and its readable details, including the hosting provider.
// Never: treats a click as consent, sends a report or opens a remote page automatically.
import { signal } from '@preact/signals';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { closeFeedback } from './popover-state.ts';

const showing = signal(false);

export function FeedbackPrivacyNote(props: { sending: boolean }) {
  return (
    <p class="feedback-privacy-note">
      {props.sending
        ? 'Text, selected screenshot and app/system details are sent encrypted to Teydra Lab.'
        : 'Save keeps this report on your PC. Nothing is sent.'}{' '}
      <button type="button" class="feedback-privacy-link" onClick={() => { closeFeedback(); showing.value = true; }}>
        Feedback privacy
      </button>
    </p>
  );
}

export function FeedbackPrivacyDialog() {
  const close = () => { showing.value = false; };
  return (
    <Dialog open={showing.value} onClose={close} title="Feedback privacy" width={640}>
      <div class="feedback-privacy-details">
        <p><strong>Who receives it.</strong> Teydra Lab, operated by Meral Anna Hees,
          Ludwig-Richter-Straße 4a/Top3, 5020 Salzburg, Austria.
          Contact: <a href="mailto:official@teydralab.com">official@teydralab.com</a>.</p>
        <p><strong>What is sent.</strong> Your feedback text, the screenshot you choose to include,
          the report ID and date, app version, operating system and the current app view.
          Reports filed by an agent are marked as such. Recent warning/error messages are included
          only when diagnostic sharing is enabled in settings. Your chat history is not attached.
          A copy of the report is saved on your PC.</p>
        <p><strong>Why.</strong> We use reports to understand problems, fix bugs and improve the app.
          Processing is based on our legitimate interest in maintaining and improving the app
          (Article 6(1)(f) GDPR). Feedback is voluntary; you can use the app without sending it.
          Please remove personal information you do not want to share, including information about
          other people, and paint over private parts of the screenshot.</p>
        <p><strong>Transport and access.</strong> Text and the selected screenshot are encrypted on your
          PC for the team's key before upload to Google Cloud Firestore. The mailbox stores encrypted
          reports; the team's receiving PC decrypts them. Reports are available to the team handling
          feedback and are not published. Google also processes connection information, such as
          your IP address and request time, to provide and secure the service.</p>
        <p><strong>Hosting.</strong> Google provides Firestore as a processor under its cloud data
          processing terms. An EU database location does not exclude international processing of
          service or support data. Google's terms describe subprocessors and safeguards for
          international transfers. See <a href="https://cloud.google.com/terms/data-processing-addendum"
            target="_blank" rel="noopener noreferrer">Google's Cloud Data Processing Addendum</a>.</p>
        <p><strong>Storage.</strong> The encrypted report stays in the mailbox until the team's PC
          successfully retrieves and saves it, then it is deleted from the mailbox. The received
          copy stays on the team's PC while needed to handle the feedback and is deleted when
          no longer needed. There is no fixed automatic deletion period. Copies on your own PC
          follow your local data and backup management.</p>
        <p><strong>Your rights.</strong> You can request access, correction, deletion or restriction,
          and object to processing based on legitimate interests. Contact us with the date and
          details of your report so we can find it; we do not require a sender account.
          You can complain to your supervisory authority, including the
          <a href="https://dsb.gv.at/" target="_blank" rel="noopener noreferrer"> Austrian Data Protection Authority</a>.
          Feedback is not used for automated decisions about you.</p>
      </div>
      <DialogActions><button type="button" class="button primary" onClick={close}>Close</button></DialogActions>
    </Dialog>
  );
}
