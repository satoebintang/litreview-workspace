export type AppraisalWorksheetFieldError = {
  controlName: string;
  fieldId: string;
  label: string;
  message: string;
};

export type AppraisalWorksheetActionState = {
  fieldErrors: AppraisalWorksheetFieldError[];
  formError: string | null;
  submittedValues?: Record<string, string[]>;
};
